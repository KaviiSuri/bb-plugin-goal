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
  readonly continuationSends: () => number;
  readonly close: () => Promise<void>;
}

function makeFixture(existingThreads: readonly string[] = ["thr_one"]): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "bb-goal-"));
  const database = new Database(join(directory, "goal.db"));
  migrateGoalDatabase(database);
  let id = 0;
  let continuationSends = 0;
  const runtime = makeGoalRuntime(
    database,
    {
      threadExists: async (threadId) => existingThreads.includes(threadId),
      readThread: async () => ({ status: "idle" }),
      sendContinuation: async () => {
        continuationSends += 1;
      },
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
    continuationSends: () => continuationSends,
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

  it("atomically completes only the exact active Goal revision with evidence", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "ship guarded Completion",
      });

      await expect(
        fixture.runtime.run({
          type: "complete",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 1,
          summary: "implemented",
          verificationEvidence: "   ",
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: "invalid_completion",
          message:
            "Goal Completion requires a summary and verification evidence.",
        },
      });

      await expect(
        fixture.runtime.run({
          type: "complete",
          threadId: "thr_one",
          goalId: "goal_wrong",
          expectedRevision: 1,
          summary: "implemented",
          verificationEvidence: "tests pass",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "goal_not_found" },
      });

      await fixture.runtime.run({
        type: "edit",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
        objective: "ship guarded Completion and history evidence",
      });
      await expect(
        fixture.runtime.run({
          type: "complete",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 1,
          summary: "implemented",
          verificationEvidence: "tests pass",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "stale_goal" },
      });

      const completed = await fixture.runtime.run({
        type: "complete",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 2,
        summary: "  Implemented guarded Completion.  ",
        verificationEvidence: "  Coordinator tests pass.  ",
      });
      expect(completed).toMatchObject({
        ok: true,
        goal: {
          id: "goal_1",
          state: "completed",
          revision: 3,
          finishedAt: "2026-08-22T12:00:00.000Z",
          completionSummary: "Implemented guarded Completion.",
          verificationEvidence: "Coordinator tests pass.",
        },
      });
      expect(
        fixture.database
          .prepare(
            `SELECT state, revision, finished_at AS finishedAt,
              completion_summary AS completionSummary,
              verification_evidence AS verificationEvidence
            FROM goals WHERE id = ?`,
          )
          .get("goal_1"),
      ).toEqual({
        state: "completed",
        revision: 3,
        finishedAt: "2026-08-22T12:00:00.000Z",
        completionSummary: "Implemented guarded Completion.",
        verificationEvidence: "Coordinator tests pass.",
      });

      await expect(
        fixture.runtime.run({
          type: "complete",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 3,
          summary: "repeat",
          verificationEvidence: "repeat",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_transition" },
      });

      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "replacement objective",
      });
      await expect(
        fixture.runtime.run({
          type: "complete",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 3,
          summary: "stale turn",
          verificationEvidence: "old evidence",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_transition" },
      });
      await expect(
        fixture.runtime.run({ type: "status", threadId: "thr_one" }),
      ).resolves.toMatchObject({
        ok: true,
        goal: { id: "goal_2", state: "active", revision: 1 },
      });
    } finally {
      await fixture.close();
    }
  });

  it("qualifies the same durable Blockage across reload before terminal report three", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "wait for the external dependency",
      });

      await expect(
        fixture.runtime.run({
          type: "block",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 1,
          externalAction: "Keep trying",
          evidence: "The next attempt may still succeed.",
          repeatedTurns: 1,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_blockage" },
      });
      await expect(
        fixture.runtime.run({
          type: "block",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 1,
          externalAction: "User must provide the credential",
          evidence: "   ",
          repeatedTurns: 1,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_blockage" },
      });

      await expect(
        fixture.runtime.run({
          type: "block",
          threadId: "thr_one",
          goalId: "goal_missing",
          expectedRevision: 1,
          externalAction: "User must provide the credential",
          evidence: "The provider rejected the request.",
          repeatedTurns: 1,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "goal_not_found" },
      });

      const edited = await fixture.runtime.run({
        type: "edit",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
        objective: "wait for the external dependency with evidence",
      });
      expect(edited).toMatchObject({ ok: true, goal: { revision: 2 } });
      await expect(
        fixture.runtime.run({
          type: "block",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 1,
          externalAction: "User must provide the credential",
          evidence: "Stale evidence.",
          repeatedTurns: 1,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "stale_goal" },
      });

      const first = await fixture.runtime.run({
        type: "block",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 2,
        externalAction: "  User must provide the credential  ",
        evidence: "  Provider rejected the first request.  ",
        repeatedTurns: 1,
      });
      expect(first).toMatchObject({
        ok: true,
        goal: { state: "active", revision: 2 },
      });

      await fixture.runtime.dispose();
      const reloaded = makeGoalRuntime(
        fixture.database,
        { threadExists: async () => true },
        {
          nextGoalId: () => "unused",
          nowIso: () => "2026-08-22T12:01:00.000Z",
        },
      );
      try {
        const second = await reloaded.run({
          type: "block",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 2,
          externalAction: "USER must provide the   credential",
          evidence: "Provider rejected the second request.",
          repeatedTurns: 2,
        });
        expect(second).toMatchObject({
          ok: true,
          goal: { state: "active", revision: 2 },
        });

        const changed = await reloaded.run({
          type: "block",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 2,
          externalAction: "User must grant filesystem access",
          evidence: "The blocker changed.",
          repeatedTurns: 3,
        });
        expect(changed).toMatchObject({
          ok: false,
          error: { code: "invalid_blockage" },
        });

        const duplicate = await reloaded.run({
          type: "block",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 2,
          externalAction: "User must provide the credential",
          evidence: "Duplicate second report.",
          repeatedTurns: 2,
        });
        expect(duplicate).toEqual({
          ok: false,
          error: {
            code: "invalid_blockage",
            message:
              "Goal Blockage report 2 is out of sequence; expected report 3.",
          },
        });

        const gap = await reloaded.run({
          type: "block",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 2,
          externalAction: "User must provide the credential",
          evidence: "Skipped report.",
          repeatedTurns: 4,
        });
        expect(gap).toMatchObject({
          ok: false,
          error: { code: "invalid_blockage" },
        });

        const blocked = await reloaded.run({
          type: "block",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 2,
          externalAction: "User must provide the credential",
          evidence: "Provider rejected all three requests with credential_missing.",
          repeatedTurns: 3,
        });
        expect(blocked).toMatchObject({
          ok: true,
          goal: {
            id: "goal_1",
            state: "blocked",
            revision: 3,
            finishedAt: "2026-08-22T12:01:00.000Z",
            blockageExternalAction: "User must provide the credential",
            blockageRepeatedTurns: 3,
          },
        });
        await expect(
          reloaded.run({ type: "status", threadId: "thr_one" }),
        ).resolves.toEqual({ ok: true, goal: null });
      } finally {
        await reloaded.dispose();
      }
    } finally {
      if (fixture.database.open) fixture.database.close();
      rmSync(fixture.directory, { recursive: true, force: true });
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

  it("retains sequential Goal history after a terminal Goal", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "first objective",
      });
      await fixture.runtime.run({
        type: "cancel",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
      });
      const second = await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "second objective",
      });
      expect(second).toMatchObject({
        ok: true,
        goal: { id: "goal_2", state: "active" },
      });

      const history = await fixture.runtime.run({
        type: "history",
        threadId: "thr_one",
        limit: 20,
        cursor: null,
      });
      expect(history).toMatchObject({
        ok: true,
        page: {
          goals: [
            { id: "goal_2", objective: "second objective", finishedAt: null },
            { id: "goal_1", objective: "first objective", state: "canceled" },
          ],
          nextCursor: null,
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("paginates newest-first history with stable opaque cursors", async () => {
    const fixture = makeFixture();
    try {
      for (let index = 1; index <= 5; index += 1) {
        await fixture.runtime.run({
          type: "start",
          threadId: "thr_one",
          objective: `objective ${index}`,
        });
        await fixture.runtime.run({
          type: "cancel",
          threadId: "thr_one",
          goalId: `goal_${index}`,
          expectedRevision: 1,
        });
      }

      const first = await fixture.runtime.run({
        type: "history",
        threadId: "thr_one",
        limit: 2,
        cursor: null,
      });
      expect(first).toMatchObject({
        ok: true,
        page: { goals: [{ id: "goal_5" }, { id: "goal_4" }] },
      });
      if (!first.ok || !("page" in first) || first.page.nextCursor === null) {
        throw new Error("Expected a history cursor");
      }
      expect(first.page.nextCursor).not.toContain("goal_4");

      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "newly inserted objective",
      });

      const second = await fixture.runtime.run({
        type: "history",
        threadId: "thr_one",
        limit: 2,
        cursor: first.page.nextCursor,
      });
      expect(second).toMatchObject({
        ok: true,
        page: {
          goals: [{ id: "goal_3" }, { id: "goal_2" }],
        },
      });
      if (!second.ok || !("page" in second) || second.page.nextCursor === null) {
        throw new Error("Expected a second history cursor");
      }
      await expect(
        fixture.runtime.run({
          type: "history",
          threadId: "thr_one",
          limit: 2,
          cursor: second.page.nextCursor,
        }),
      ).resolves.toMatchObject({
        ok: true,
        page: { goals: [{ id: "goal_1" }], nextCursor: null },
      });
    } finally {
      await fixture.close();
    }
  });

  it("rejects malformed and cross-thread history cursors", async () => {
    const fixture = makeFixture(["thr_one", "thr_two"]);
    try {
      for (let index = 1; index <= 2; index += 1) {
        await fixture.runtime.run({
          type: "start",
          threadId: "thr_one",
          objective: `objective ${index}`,
        });
        await fixture.runtime.run({
          type: "cancel",
          threadId: "thr_one",
          goalId: `goal_${index}`,
          expectedRevision: 1,
        });
      }
      const first = await fixture.runtime.run({
        type: "history",
        threadId: "thr_one",
        limit: 1,
        cursor: null,
      });
      if (!first.ok || !("page" in first) || first.page.nextCursor === null) {
        throw new Error("Expected a history cursor");
      }

      for (const [threadId, cursor] of [
        ["thr_one", "not-a-cursor"],
        ["thr_two", first.page.nextCursor],
      ] as const) {
        await expect(
          fixture.runtime.run({
            type: "history",
            threadId,
            limit: 1,
            cursor,
          }),
        ).resolves.toEqual({
          ok: false,
          error: {
            code: "invalid_cursor",
            message: "The Goal history cursor is invalid or expired.",
          },
        });
      }
    } finally {
      await fixture.close();
    }
  });

  it("shows one Goal and deletes only the revision-guarded record", async () => {
    const fixture = makeFixture(["thr_one", "thr_two"]);
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "historical objective",
      });
      await fixture.runtime.run({
        type: "cancel",
        threadId: "thr_one",
        goalId: "goal_1",
        expectedRevision: 1,
      });
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "current objective",
      });

      await expect(
        fixture.runtime.run({ type: "show", goalId: "goal_1" }),
      ).resolves.toMatchObject({
        ok: true,
        goal: { id: "goal_1", state: "canceled", revision: 2 },
      });
      await expect(
        fixture.runtime.run({ type: "show", goalId: "goal_missing" }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: "goal_not_found",
          message: "Goal goal_missing was not found.",
        },
      });

      await expect(
        fixture.runtime.run({
          type: "delete",
          threadId: "thr_two",
          goalId: "goal_2",
          expectedRevision: 1,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "goal_not_found" },
      });
      await expect(
        fixture.runtime.run({
          type: "delete",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 1,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "stale_goal" },
      });

      await expect(
        fixture.runtime.run({
          type: "delete",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 2,
        }),
      ).resolves.toMatchObject({ ok: true, goal: { id: "goal_1" } });
      await expect(
        fixture.runtime.run({ type: "status", threadId: "thr_one" }),
      ).resolves.toMatchObject({
        ok: true,
        goal: { id: "goal_2", objective: "current objective" },
      });
      expect(
        fixture.database
          .prepare("SELECT id FROM goals ORDER BY id")
          .all(),
      ).toEqual([{ id: "goal_2" }]);
    } finally {
      await fixture.close();
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

  it("claims one idle opportunity and survives continuation crashes and reloads", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "continue safely",
      });

      await fixture.runtime.enqueueIdle("thr_one", "idle-before-claim");
      const [first, duplicate] = await Promise.all([
        fixture.runtime.processContinuation(new AbortController().signal),
        fixture.runtime.processContinuation(new AbortController().signal),
      ]);
      expect(first || duplicate).toBe(true);
      expect(fixture.continuationSends()).toBe(1);
      expect(
        fixture.database
          .prepare(
            "SELECT state, outcome, attempt FROM goal_continuations WHERE opportunity_key = ?",
          )
          .get("idle-before-claim"),
      ).toEqual({ state: "resolved", outcome: "sent", attempt: 1 });

      await fixture.runtime.enqueueIdle("thr_one", "idle-before-claim");
      expect(
        await fixture.runtime.processContinuation(new AbortController().signal),
      ).toBe(false);
      expect(fixture.continuationSends()).toBe(1);

      await fixture.runtime.enqueueIdle("thr_one", "idle-after-claim");
      fixture.database
        .prepare(
          "UPDATE goal_continuations SET state = 'claimed', lease_expires_at = ? WHERE opportunity_key = ?",
        )
        .run("2026-08-22T12:01:00.000Z", "idle-after-claim");
      await fixture.runtime.dispose();
      let reloaded = makeGoalRuntime(
        fixture.database,
        {
          threadExists: async () => true,
          readThread: async () => ({ status: "idle" }),
          sendContinuation: async () => {
            // The fixture's original adapter owns the observable count.
          },
        },
        {
          nextGoalId: () => "unused_after_claim",
          nowIso: () => "2026-08-22T12:00:00.000Z",
        },
      );
      try {
        await reloaded.recoverContinuations();
        expect(
          await reloaded.processContinuation(new AbortController().signal),
        ).toBe(true);
        expect(
          fixture.database
            .prepare(
              "SELECT state, outcome, attempt FROM goal_continuations WHERE opportunity_key = ?",
            )
            .get("idle-after-claim"),
        ).toMatchObject({ state: "resolved", outcome: "sent", attempt: 1 });
      } finally {
        await reloaded.dispose();
      }

      await fixture.runtime.dispose();
      reloaded = makeGoalRuntime(
        fixture.database,
        {
          threadExists: async () => true,
          readThread: async () => ({ status: "idle" }),
          sendContinuation: async () => {
            // An ambiguous send is resolved without replay after restart.
          },
        },
        {
          nextGoalId: () => "unused_after_send",
          nowIso: () => "2026-08-22T12:00:00.000Z",
        },
      );
      await reloaded.enqueueIdle("thr_one", "idle-after-send");
      fixture.database
        .prepare(
          "UPDATE goal_continuations SET state = 'sending' WHERE opportunity_key = ?",
        )
        .run("idle-after-send");
      await reloaded.recoverContinuations();
      expect(
        await reloaded.processContinuation(new AbortController().signal),
      ).toBe(false);
      expect(
        fixture.database
          .prepare(
            "SELECT state, outcome FROM goal_continuations WHERE opportunity_key = ?",
          )
          .get("idle-after-send"),
      ).toEqual({ state: "resolved", outcome: "sent" });
      await reloaded.dispose();

      const stale = makeGoalRuntime(
        fixture.database,
        {
          threadExists: async () => true,
          readThread: async () => ({ status: "idle" }),
          sendContinuation: async () => {
            throw new Error("must not send stale Goal");
          },
        },
        {
          nextGoalId: () => "unused_stale",
          nowIso: () => "2026-08-22T12:00:00.000Z",
        },
      );
      try {
        await stale.enqueueIdle("thr_one", "idle-stale");
        await stale.run({
          type: "edit",
          threadId: "thr_one",
          goalId: "goal_1",
          expectedRevision: 1,
          objective: "edited after idle claim",
        });
        expect(
          await stale.processContinuation(new AbortController().signal),
        ).toBe(true);
        expect(
          fixture.database
            .prepare(
              "SELECT state, outcome FROM goal_continuations WHERE opportunity_key = ?",
            )
            .get("idle-stale"),
        ).toEqual({ state: "resolved", outcome: "released" });
      } finally {
        await stale.dispose();
      }
    } finally {
      if (fixture.database.open) fixture.database.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("recovers a pending Continuation after a restart before its claim", async () => {
    const fixture = makeFixture();
    try {
      await fixture.runtime.run({
        type: "start",
        threadId: "thr_one",
        objective: "recover the pending opportunity",
      });
      await fixture.runtime.enqueueIdle("thr_one", "idle-pending-restart");
      await fixture.runtime.dispose();

      const reloaded = makeGoalRuntime(
        fixture.database,
        {
          threadExists: async () => true,
          readThread: async () => ({ status: "idle" }),
          sendContinuation: async () => {},
        },
        {
          nextGoalId: () => "unused_pending",
          nowIso: () => "2026-08-22T12:00:00.000Z",
        },
      );
      try {
        await reloaded.recoverContinuations();
        expect(
          await reloaded.processContinuation(new AbortController().signal),
        ).toBe(true);
        expect(
          fixture.database
            .prepare(
              "SELECT state, outcome, attempt FROM goal_continuations WHERE opportunity_key = ?",
            )
            .get("idle-pending-restart"),
        ).toEqual({ state: "resolved", outcome: "sent", attempt: 1 });
      } finally {
        await reloaded.dispose();
      }
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
