import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { it as effectIt } from "@effect/vitest";
import { migrateGoalDatabase } from "./repository";
import { makeGoalRuntime, type GoalRuntime } from "./runtime";

interface Fixture {
  readonly database: Database.Database;
  readonly directory: string;
  readonly runtime: GoalRuntime;
  readonly close: () => Promise<void>;
}

function makeFixture(existingThreads: readonly string[] = ["thr_one"]): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "bb-goal-"));
  const database = new Database(join(directory, "goal.db"));
  migrateGoalDatabase(database);
  let id = 0;
  const runtime = makeGoalRuntime(
    database,
    {
      threadExists: async (threadId) => existingThreads.includes(threadId),
    },
    {
      nextGoalId: () => `goal_${++id}`,
      nowIso: () => "2026-08-22T12:00:00.000Z",
    },
  );
  return {
    database,
    directory,
    runtime,
    async close() {
      await runtime.dispose();
      if (database.open) database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("Goal coordinator", () => {
  it("enforces one unfinished Goal per thread in real SQLite", async () => {
    const fixture = makeFixture();
    try {
      const first = await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "  finish the parser  ",
      });
      expect(first).toMatchObject({
        ok: true,
        goal: {
          id: "goal_1",
          threadId: "thr_one",
          objective: "finish the parser",
          state: "active",
          revision: 1,
        },
      });

      const second = await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "competing work",
      });
      expect(second).toEqual({
        ok: false,
        error: {
          code: "goal_already_exists",
          message: "Thread thr_one already has unfinished Goal goal_1.",
        },
      });
      expect(
        fixture.database.prepare("SELECT COUNT(*) AS count FROM goals").get(),
      ).toEqual({ count: 1 });
    } finally {
      await fixture.close();
    }
  });

  it("database rejects a second unfinished Goal for one thread", async () => {
    const fixture = makeFixture();
    try {
      const insert = fixture.database.prepare(
        `INSERT INTO goals (
          id, thread_id, objective, state, revision,
          created_at, updated_at, finished_at
        ) VALUES (?, 'thr_one', ?, 'active', 1, ?, ?, NULL)`,
      );
      const createdAt = "2026-08-22T12:00:00.000Z";

      insert.run("goal_database_1", "first objective", createdAt, createdAt);

      expect(() =>
        insert.run(
          "goal_database_2",
          "competing objective",
          createdAt,
          createdAt,
        ),
      ).toThrow(/UNIQUE constraint failed: goals\.thread_id/);
      expect(
        fixture.database.prepare("SELECT COUNT(*) AS count FROM goals").get(),
      ).toEqual({ count: 1 });
    } finally {
      await fixture.close();
    }
  });

  it("restores the current Goal after coordinator reconstruction", async () => {
    const fixture = makeFixture();
    try {
      const started = await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "survive reload",
      });
      expect(started.ok).toBe(true);
      await fixture.runtime.dispose();

      const reloaded = makeGoalRuntime(
        fixture.database,
        { threadExists: async () => true },
        {
          nextGoalId: () => "goal_unused",
          nowIso: () => "2026-08-22T12:01:00.000Z",
        },
      );
      try {
        await expect(
          reloaded.run({ type: "status", threadId: "thr_one" }),
        ).resolves.toMatchObject({
          ok: true,
          goal: { id: "goal_1", objective: "survive reload" },
        });
      } finally {
        await reloaded.dispose();
      }
    } finally {
      if (fixture.database.open) fixture.database.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects commands for a missing existing thread", async () => {
    const fixture = makeFixture([]);
    try {
      await expect(
        fixture.runtime.run({
          type: "start",
          threadId: "thr_missing",
          objective: "cannot attach",
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: "thread_not_found",
          message: "Thread thr_missing was not found.",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("does not open or close a second SQLite owner", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "status",
        threadId: "thr_one",
      });
      await fixture.runtime.dispose();
      expect(fixture.database.open).toBe(true);
      expect(fixture.database.prepare("SELECT 1 AS value").get()).toEqual({
        value: 1,
      });
    } finally {
      if (fixture.database.open) fixture.database.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  effectIt.effect("runs the exact-pinned Effect coordinator runtime", () =>
    Effect.tryPromise(async () => {
      const fixture = makeFixture();
      try {
        const result = await fixture.runtime.run({
          type: "status",
          threadId: "thr_one",
        });
        expect(result).toEqual({ ok: true, goal: null });
      } finally {
        await fixture.close();
      }
    }),
  );
});
