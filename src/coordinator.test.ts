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

  it("edits an unfinished Goal in place and rejects stale revision guards", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "first objective",
      });

      const edited = await fixture.runtime.run({
        type: "edit",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
        objective: "  redirected objective  ",
      });
      expect(edited).toMatchObject({
        ok: true,
        goal: {
          id: "goal_1",
          objective: "redirected objective",
          revision: 2,
          state: "active",
        },
      });

      const stale = await fixture.runtime.run({
        type: "pause",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
      });
      expect(stale).toEqual({
        ok: false,
        error: {
          code: "stale_goal",
          message:
            "Goal goal_1 changed from revision 1 to 2. Refresh and retry.",
        },
      });
      await expect(
        fixture.runtime.run({ type: "status", threadId: "thr_one" }),
      ).resolves.toMatchObject({
        ok: true,
        goal: {
          id: "goal_1",
          objective: "redirected objective",
          revision: 2,
          state: "active",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("guards pause, resume, and terminal cancellation transitions", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "control lifecycle",
      });

      const invalidResume = await fixture.runtime.run({
        type: "resume",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
      });
      expect(invalidResume).toMatchObject({
        ok: false,
        error: { code: "invalid_transition" },
      });

      const paused = await fixture.runtime.run({
        type: "pause",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
      });
      expect(paused).toMatchObject({
        ok: true,
        goal: { state: "paused", revision: 2, finishedAt: null },
      });

      const repeatedPause = await fixture.runtime.run({
        type: "pause",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 2,
      });
      expect(repeatedPause).toEqual({
        ok: false,
        error: {
          code: "invalid_transition",
          message: "Cannot pause Goal goal_1 while it is paused.",
        },
      });

      const resumed = await fixture.runtime.run({
        type: "resume",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 2,
      });
      expect(resumed).toMatchObject({
        ok: true,
        goal: { state: "active", revision: 3, finishedAt: null },
      });

      const canceled = await fixture.runtime.run({
        type: "cancel",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 3,
      });
      expect(canceled).toMatchObject({
        ok: true,
        goal: {
          id: "goal_1",
          state: "canceled",
          revision: 4,
          finishedAt: "2026-08-22T12:00:00.000Z",
        },
      });
      await expect(
        fixture.runtime.run({ type: "status", threadId: "thr_one" }),
      ).resolves.toEqual({ ok: true, goal: null });
      expect(
        fixture.database
          .prepare(
            "SELECT state, revision, finished_at AS finishedAt FROM goals WHERE id = ?",
          )
          .get("goal_1"),
      ).toEqual({
        state: "canceled",
        revision: 4,
        finishedAt: "2026-08-22T12:00:00.000Z",
      });

      const repeatedCancel = await fixture.runtime.run({
        type: "cancel",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 4,
      });
      expect(repeatedCancel).toMatchObject({
        ok: false,
        error: { code: "invalid_transition" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("allows edit and cancel but not pause or resume while waiting", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "wait for capacity",
      });
      fixture.database
        .prepare("UPDATE goals SET state = 'waiting' WHERE id = ?")
        .run("goal_1");

      const edited = await fixture.runtime.run({
        type: "edit",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
        objective: "wait for a safe reset",
      });
      expect(edited).toMatchObject({
        ok: true,
        goal: { state: "waiting", revision: 2 },
      });

      for (const type of ["pause", "resume"] as const) {
        const rejected = await fixture.runtime.run({
          type,
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 2,
        });
        expect(rejected).toMatchObject({
          ok: false,
          error: { code: "invalid_transition" },
        });
      }

      const canceled = await fixture.runtime.run({
        type: "cancel",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 2,
      });
      expect(canceled).toMatchObject({
        ok: true,
        goal: { state: "canceled", revision: 3 },
      });
    } finally {
      await fixture.close();
    }
  });

  it("rejects invalid edits and unknown Goal guards without writing", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "preserve me",
      });

      const emptyEdit = await fixture.runtime.run({
        type: "edit",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
        objective: "   ",
      });
      expect(emptyEdit).toMatchObject({
        ok: false,
        error: { code: "invalid_objective" },
      });

      const missing = await fixture.runtime.run({
        type: "pause",
        threadId: "thr_one",
        goalId: "goal_missing",
        expectedRevision: 1,
      });
      expect(missing).toEqual({
        ok: false,
        error: {
          code: "goal_not_found",
          message: "Goal goal_missing was not found on thread thr_one.",
        },
      });
      expect(
        fixture.database
          .prepare("SELECT objective, state, revision FROM goals WHERE id = ?")
          .get("goal_1"),
      ).toEqual({ objective: "preserve me", state: "active", revision: 1 });
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
