import { describe, expect, it } from "vitest";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { createPlugin } from "./server";
import type { GoalDto } from "./src/domain";
import { GOAL_MIGRATIONS } from "./src/repository";
import { makeGoalRuntime, type GoalRuntime } from "./src/runtime";

function deterministicPlugin() {
  let id = 0;
  let tick = 0;
  return createPlugin({
    makeRuntime(database, gateway) {
      return makeGoalRuntime(database, gateway, {
        nextGoalId: () => `goal_cli_${++id}`,
        nowIso: () =>
          new Date(Date.UTC(2026, 7, 22, 12, 0, tick++)).toISOString(),
      });
    },
  });
}

function agentContext(
  providerId: string,
): PluginAgentConfigurationContext {
  return {
    thread: {
      id: "thr_agent",
      title: "Goal agent",
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: {
      id: "proj_test",
      kind: "standard",
      name: "Goal test",
      gitRemoteUrl: null,
    },
    environment: {
      id: "env_test",
      name: "Goal environment",
      path: "/workspace",
      workspaceProvisionType: "managed-worktree",
      branchName: "test",
    },
    host: { id: "host_test", name: "test host" },
    provider: {
      id: providerId,
      model: "test-model",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId: null },
  };
}

function fakeHost() {
  return createFakePluginHost({
    pluginId: "goal",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          if (threadId === "thr_missing") throw new Error("not found");
          return makeThreadResponse({
            id: threadId,
            environmentId: "env_test",
          });
        },
      },
      environments: {
        get: async () => ({ hostId: "host_test" }),
      },
      files: {
        read: async ({ path }) => ({
          path,
          content: "Objective read from the invoking machine.\n",
          contentEncoding: "utf8" as const,
          sizeBytes: 42,
          sha256: "sha-test",
        }),
      },
    },
  });
}

describe("Goal BB adapter", () => {
  it("registers the public RPC and CLI routes", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    try {
      expect(harness.inspection.registrations.rpcMethods).toEqual([
        "start",
        "status",
        "edit",
        "pause",
        "resume",
        "cancel",
        "history",
        "show",
        "delete",
      ]);
      expect(harness.inspection.registrations.agentTools).toMatchObject([
        { name: "goal_complete" },
        { name: "goal_blocked" },
      ]);
      expect(
        harness.inspection.registrations.agentConfigurationProvider,
      ).not.toBeNull();
      expect(harness.inspection.registrations.cli).toMatchObject({
        name: "goal",
        commands: [
          { name: "start" },
          { name: "status" },
          { name: "edit" },
          { name: "pause" },
          { name: "resume" },
          { name: "cancel" },
          { name: "history" },
          { name: "show" },
          { name: "delete" },
        ],
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("contributes the same bounded active Goal context to every provider without running Effect", async () => {
    let runtimeRuns = 0;
    const observedPlugin = createPlugin({
      makeRuntime(database, gateway): GoalRuntime {
        const runtime = makeGoalRuntime(database, gateway, {
          nextGoalId: () => "goal_agent",
          nowIso: () => "2026-08-22T12:00:00.000Z",
        });
        return {
          async run(command) {
            runtimeRuns += 1;
            return runtime.run(command);
          },
          dispose: runtime.dispose,
        };
      },
    });
    const { bb, harness } = fakeHost();
    await observedPlugin(bb);
    try {
      const empty = await harness.behavior.resolveAgentConfiguration(
        agentContext("pi"),
      );
      expect(empty).toEqual({ tools: [], skills: [], instructions: null });
      expect(runtimeRuns).toBe(0);

      await harness.behavior.callRpc("start", {
        threadId: "thr_agent",
        objective: "Finish the provider-independent Completion path.",
      });
      expect(runtimeRuns).toBe(1);
      const gatewayCalls = harness.inspection.sdk.callsTo("threads.get").length;

      for (const providerId of ["pi", "claude-code", "codex", "acp-test"]) {
        const configuration =
          await harness.behavior.resolveAgentConfiguration(
            agentContext(providerId),
          );
        expect(configuration.instructions).toContain(
          "Exact Goal ID: goal_agent",
        );
        expect(configuration.instructions).toContain("Goal revision: 1");
        expect(configuration.instructions).toContain(
          "Finish the provider-independent Completion path.",
        );
        expect(configuration.instructions).toContain(
          "Only the user may edit, pause, resume, cancel, or delete this Goal.",
        );
        expect(configuration.instructions).toContain(
          "Call goal_complete only after every requirement is satisfied and verified.",
        );
        expect(configuration.instructions!.length).toBeLessThanOrEqual(4096);
        expect(configuration.tools).toHaveLength(2);
        expect(configuration.tools[0]).toMatchObject({
          name: "goal_complete",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              goalId: { const: "goal_agent" },
              expectedRevision: { const: 1 },
            },
          },
        });
        expect(configuration.tools[1]).toMatchObject({
          name: "goal_blocked",
          inputSchema: {
            properties: {
              goalId: { const: "goal_agent" },
              expectedRevision: { const: 1 },
              repeatedTurns: { minimum: 1 }
            },
          },
        });
      }

      expect(runtimeRuns).toBe(1);
      expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(
        gatewayCalls,
      );
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("withholds Goal context while paused and restores the resumed revision", async () => {
    const { bb, harness } = fakeHost();
    await deterministicPlugin()(bb);
    try {
      const started = (await harness.behavior.callRpc("start", {
        threadId: "thr_agent",
        objective: "Pause before continuing",
      })) as { goal: GoalDto };
      const paused = (await harness.behavior.callRpc("pause", {
        threadId: "thr_agent",
        goalId: started.goal.id,
        expectedRevision: started.goal.revision,
      })) as { goal: GoalDto };
      expect(paused.goal).toMatchObject({ state: "paused", revision: 2 });

      await expect(
        harness.behavior.resolveAgentConfiguration(agentContext("pi")),
      ).resolves.toEqual({ tools: [], skills: [], instructions: null });

      const resumed = (await harness.behavior.callRpc("resume", {
        threadId: "thr_agent",
        goalId: paused.goal.id,
        expectedRevision: paused.goal.revision,
      })) as { goal: GoalDto };
      expect(resumed.goal).toMatchObject({ state: "active", revision: 3 });

      const configuration =
        await harness.behavior.resolveAgentConfiguration(
          agentContext("codex"),
        );
      expect(configuration.instructions).toContain(
        `Exact Goal ID: ${resumed.goal.id}`,
      );
      expect(configuration.instructions).toContain("Goal revision: 3");
      expect(configuration.instructions).toContain("Pause before continuing");
      expect(configuration.tools).toMatchObject([
        {
          name: "goal_complete",
          inputSchema: {
            properties: {
              goalId: { const: resumed.goal.id },
              expectedRevision: { const: 3 },
            },
          },
        },
        {
          name: "goal_blocked",
          inputSchema: {
            properties: {
              goalId: { const: resumed.goal.id },
              expectedRevision: { const: 3 },
            },
          },
        },
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("guards agent Completion end to end and publishes plain terminal DTOs", async () => {
    const { bb, harness } = fakeHost();
    await deterministicPlugin()(bb);
    try {
      const started = (await harness.behavior.callRpc("start", {
        threadId: "thr_agent",
        objective: "Finish guarded Completion",
      })) as { goal: GoalDto };

      await expect(
        harness.behavior.callAgentTool(
          "goal_complete",
          {
            goalId: started.goal.id,
            expectedRevision: 1,
            summary: "Implemented Completion",
          },
          { threadId: "thr_agent" },
        ),
      ).rejects.toThrow(/verificationEvidence/);
      await expect(
        harness.behavior.callAgentTool(
          "goal_complete",
          {
            goalId: "goal_wrong",
            expectedRevision: 1,
            summary: "Implemented Completion",
            verificationEvidence: "Tests pass",
          },
          { threadId: "thr_agent" },
        ),
      ).rejects.toThrow("[goal_not_found]");

      const edited = (await harness.behavior.callRpc("edit", {
        threadId: "thr_agent",
        goalId: started.goal.id,
        expectedRevision: 1,
        objective: "Finish guarded Completion with history",
      })) as { goal: GoalDto };
      await expect(
        harness.behavior.callAgentTool(
          "goal_complete",
          {
            goalId: started.goal.id,
            expectedRevision: 1,
            summary: "Stale summary",
            verificationEvidence: "Stale evidence",
          },
          { threadId: "thr_agent" },
        ),
      ).rejects.toThrow("[stale_goal]");

      const toolResult = await harness.behavior.callAgentTool(
        "goal_complete",
        {
          goalId: edited.goal.id,
          expectedRevision: edited.goal.revision,
          summary: "Implemented guarded Completion.",
          verificationEvidence: "Coordinator and fake-host tests pass.",
        },
        { threadId: "thr_agent" },
      );
      expect(toolResult).toMatchObject({
        content: [{ type: "text" }],
      });
      if (typeof toolResult === "string") {
        throw new Error("Expected a structured tool result");
      }
      const content = toolResult.content[0];
      if (content?.type !== "text") {
        throw new Error("Expected text tool content");
      }
      const toolDto = JSON.parse(content.text) as { goal: GoalDto };
      expect(toolDto).toMatchObject({
        goal: {
          id: edited.goal.id,
          threadId: "thr_agent",
          objective: "Finish guarded Completion with history",
          state: "completed",
          revision: 3,
          completionSummary: "Implemented guarded Completion.",
          verificationEvidence: "Coordinator and fake-host tests pass.",
        },
      });
      expect(toolDto.goal.finishedAt).not.toBeNull();
      expect(toolDto.goal.updatedAt).toBe(toolDto.goal.finishedAt);
      expect(Object.getPrototypeOf(toolDto.goal)).toBe(Object.prototype);
      expect(harness.inspection.realtimeSignals).toHaveLength(3);
      expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({
        channel: "goal.changed",
        payload: {
          threadId: "thr_agent",
          goalId: edited.goal.id,
          revision: 3,
          state: "completed",
        },
      });
      await expect(
        harness.behavior.callRpc("status", { threadId: "thr_agent" }),
      ).resolves.toEqual({ goal: null });
      await expect(
        harness.behavior.callRpc("history", {
          threadId: "thr_agent",
          limit: 20,
          cursor: null,
        }),
      ).resolves.toMatchObject({
        goals: [
          {
            id: edited.goal.id,
            state: "completed",
            completionSummary: "Implemented guarded Completion.",
            verificationEvidence: "Coordinator and fake-host tests pass.",
          },
        ],
      });

      await expect(
        harness.behavior.callAgentTool(
          "goal_complete",
          {
            goalId: edited.goal.id,
            expectedRevision: 3,
            summary: "Repeated Completion",
            verificationEvidence: "Repeated evidence",
          },
          { threadId: "thr_agent" },
        ),
      ).rejects.toThrow("[invalid_transition]");

      const replacement = (await harness.behavior.callRpc("start", {
        threadId: "thr_agent",
        objective: "Replacement Goal",
      })) as { goal: GoalDto };
      await expect(
        harness.behavior.callAgentTool(
          "goal_complete",
          {
            goalId: edited.goal.id,
            expectedRevision: 3,
            summary: "Old turn",
            verificationEvidence: "Old evidence",
          },
          { threadId: "thr_agent" },
        ),
      ).rejects.toThrow("[invalid_transition]");
      await expect(
        harness.behavior.callRpc("status", { threadId: "thr_agent" }),
      ).resolves.toEqual({ goal: replacement.goal });

      const shown = await harness.behavior.runCli([
        "show",
        edited.goal.id,
      ]);
      expect(shown.stdout).toContain(
        "Completion summary: Implemented guarded Completion.",
      );
      expect(shown.stdout).toContain(
        "Verification evidence: Coordinator and fake-host tests pass.",
      );
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("qualifies agent Blockage reports across a fake-host reload", async () => {
    const initial = fakeHost();
    const observedPlugin = deterministicPlugin();
    await observedPlugin(initial.bb);
    try {
      const started = (await initial.harness.behavior.callRpc("start", {
        threadId: "thr_blocked",
        objective: "reach the external dependency",
      })) as { goal: GoalDto };

      await expect(
        initial.harness.behavior.callAgentTool(
          "goal_blocked",
          {
            goalId: "goal_wrong",
            expectedRevision: 1,
            externalAction: "User must provide a credential",
            evidence: "The provider rejected the request.",
            repeatedTurns: 1,
          },
          { threadId: "thr_blocked" },
        ),
      ).rejects.toThrow("[goal_not_found]");
      await expect(
        initial.harness.behavior.callAgentTool(
          "goal_blocked",
          {
            goalId: started.goal.id,
            expectedRevision: 1,
            externalAction: "User must provide a credential",
            evidence: "The provider rejected the request.",
            repeatedTurns: 0,
          },
          { threadId: "thr_blocked" },
        ),
      ).rejects.toThrow(/repeatedTurns/);

      const first = await initial.harness.behavior.callAgentTool(
        "goal_blocked",
        {
          goalId: started.goal.id,
          expectedRevision: 1,
          externalAction: "  User must provide a credential  ",
          evidence: "The provider rejected the first request.",
          repeatedTurns: 1,
        },
        { threadId: "thr_blocked" },
      );
      if (typeof first === "string") throw new Error("Expected structured result");
      const firstContent = first.content[0];
      if (firstContent?.type !== "text") throw new Error("Expected text content");
      expect(JSON.parse(firstContent.text)).toMatchObject({
        goal: { state: "active", revision: 1 },
        blockageReport: {
          status: "qualifying",
          repeatedTurns: 1,
          turnsRemaining: 2,
        },
      });
      expect(
        initial.bb.storage
          .database()
          .prepare("SELECT * FROM goal_blockage_qualifications")
          .all(),
      ).toEqual([
        {
          goal_id: started.goal.id,
          thread_id: "thr_blocked",
          goal_revision: 1,
          blocker_key: "user must provide a credential",
          external_action: "User must provide a credential",
          evidence: "The provider rejected the first request.",
          repeated_turns: 1,
          updated_at: expect.any(String),
        },
      ]);

      const reloaded = await initial.harness.lifecycle.reload(observedPlugin);
      try {
        const second = await reloaded.harness.behavior.callAgentTool(
          "goal_blocked",
          {
            goalId: started.goal.id,
            expectedRevision: 1,
            externalAction: "USER must provide a   credential",
            evidence: "The provider rejected the second request.",
            repeatedTurns: 2,
          },
          { threadId: "thr_blocked" },
        );
        if (typeof second === "string") throw new Error("Expected structured result");
        const secondContent = second.content[0];
        if (secondContent?.type !== "text") throw new Error("Expected text content");
        expect(JSON.parse(secondContent.text)).toMatchObject({
          goal: { state: "active", revision: 1 },
          blockageReport: { status: "qualifying", repeatedTurns: 2 },
        });

        await expect(
          reloaded.harness.behavior.callAgentTool(
            "goal_blocked",
            {
              goalId: started.goal.id,
              expectedRevision: 1,
              externalAction: "User must grant filesystem access",
              evidence: "The blocker changed.",
              repeatedTurns: 3,
            },
            { threadId: "thr_blocked" },
          ),
        ).rejects.toThrow(/same external blocker/);
        await expect(
          reloaded.harness.behavior.callAgentTool(
            "goal_blocked",
            {
              goalId: started.goal.id,
              expectedRevision: 1,
              externalAction: "User must provide a credential",
              evidence: "Duplicate second report.",
              repeatedTurns: 2,
            },
            { threadId: "thr_blocked" },
          ),
        ).rejects.toThrow(/expected report 3/);

        const toolResult = await reloaded.harness.behavior.callAgentTool(
          "goal_blocked",
          {
            goalId: started.goal.id,
            expectedRevision: 1,
            externalAction: "User must provide a credential",
            evidence: "Provider rejected all three requests with credential_missing.",
            repeatedTurns: 3,
          },
          { threadId: "thr_blocked" },
        );
        if (typeof toolResult === "string") {
          throw new Error("Expected a structured tool result");
        }
        const content = toolResult.content[0];
        if (content?.type !== "text") {
          throw new Error("Expected text tool content");
        }
        expect(JSON.parse(content.text)).toMatchObject({
          goal: {
            id: started.goal.id,
            state: "blocked",
            revision: 2,
            blockageExternalAction: "User must provide a credential",
            blockageRepeatedTurns: 3,
          },
          blockageReport: { status: "blocked", repeatedTurns: 3 },
        });
        expect(reloaded.harness.inspection.realtimeSignals.at(-1)).toMatchObject({
          channel: "goal.changed",
          payload: {
            threadId: "thr_blocked",
            goalId: started.goal.id,
            revision: 2,
            state: "blocked",
          },
        });
        await expect(
          reloaded.harness.behavior.callRpc("history", {
            threadId: "thr_blocked",
            limit: 20,
            cursor: null,
          }),
        ).resolves.toMatchObject({
          goals: [
            {
              state: "blocked",
              blockageExternalAction: "User must provide a credential",
              blockageRepeatedTurns: 3,
            },
          ],
        });
        const shown = await reloaded.harness.behavior.runCli([
          "show",
          started.goal.id,
        ]);
        expect(shown.stdout).toContain(
          "External action required: User must provide a credential",
        );
      } finally {
        await reloaded.harness.lifecycle.dispose();
      }
    } finally {
      await initial.harness.lifecycle.dispose();
    }
  });

  it("backfills legacy Goal rows through the production migration runner", async () => {
    const initial = fakeHost();
    await (async (bb: Parameters<typeof plugin>[0]) => {
      const database = bb.storage.database();
      bb.storage.migrate(database, [...GOAL_MIGRATIONS.slice(0, 2)]);
      const insert = database.prepare(
        `INSERT INTO goals (
          id, thread_id, objective, state, revision,
          created_at, updated_at, finished_at
        ) VALUES (?, 'thr_legacy', ?, 'canceled', 2, ?, ?, ?)`,
      );
      insert.run(
        "goal_legacy_first",
        "first legacy objective",
        "2026-08-22T11:00:00.000Z",
        "2026-08-22T11:01:00.000Z",
        "2026-08-22T11:01:00.000Z",
      );
      insert.run(
        "goal_legacy_second",
        "second legacy objective",
        "2026-08-22T11:00:00.000Z",
        "2026-08-22T11:02:00.000Z",
        "2026-08-22T11:02:00.000Z",
      );
    })(initial.bb);

    const migrated = await initial.harness.lifecycle.reload(
      deterministicPlugin(),
    );
    try {
      await expect(
        migrated.harness.behavior.callRpc("history", {
          threadId: "thr_legacy",
          limit: 20,
          cursor: null,
        }),
      ).resolves.toMatchObject({
        goals: [
          { id: "goal_legacy_second" },
          { id: "goal_legacy_first" },
        ],
        nextCursor: null,
      });
    } finally {
      await migrated.harness.lifecycle.dispose();
    }
  });

  it("keeps RPC Goal DTOs durable across a fake-host reload", async () => {
    const initial = fakeHost();
    await plugin(initial.bb);

    const started = await initial.harness.behavior.callRpc("start", {
      threadId: "thr_rpc",
      objective: "Persist through reload",
    });
    expect(started).toMatchObject({
      goal: {
        threadId: "thr_rpc",
        objective: "Persist through reload",
        state: "active",
        revision: 1,
      },
    });
    expect(initial.harness.inspection.realtimeSignals).toHaveLength(1);

    const reloaded = await initial.harness.lifecycle.reload(plugin);
    try {
      await expect(
        reloaded.harness.behavior.callRpc("status", {
          threadId: "thr_rpc",
        }),
      ).resolves.toEqual(started);
    } finally {
      await reloaded.harness.lifecycle.dispose();
    }
  });

  it("provides guarded RPC lifecycle routes and publishes each mutation", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    try {
      const started = (await harness.behavior.callRpc("start", {
        threadId: "thr_rpc_control",
        objective: "initial objective",
      })) as { goal: GoalDto };
      const edited = (await harness.behavior.callRpc("edit", {
        threadId: "thr_rpc_control",
        goalId: started.goal.id,
        expectedRevision: 1,
        objective: "redirected objective",
      })) as { goal: GoalDto };
      expect(edited.goal).toMatchObject({
        id: started.goal.id,
        objective: "redirected objective",
        revision: 2,
      });

      await expect(
        harness.behavior.callRpc("pause", {
          threadId: "thr_rpc_control",
          goalId: started.goal.id,
          expectedRevision: 1,
        }),
      ).rejects.toThrow("[stale_goal]");
      expect(harness.inspection.realtimeSignals).toHaveLength(2);

      const paused = (await harness.behavior.callRpc("pause", {
        threadId: "thr_rpc_control",
        goalId: started.goal.id,
        expectedRevision: 2,
      })) as { goal: GoalDto };
      expect(paused.goal).toMatchObject({ state: "paused", revision: 3 });

      const resumed = (await harness.behavior.callRpc("resume", {
        threadId: "thr_rpc_control",
        goalId: started.goal.id,
        expectedRevision: 3,
      })) as { goal: GoalDto };
      expect(resumed.goal).toMatchObject({ state: "active", revision: 4 });

      const canceled = (await harness.behavior.callRpc("cancel", {
        threadId: "thr_rpc_control",
        goalId: started.goal.id,
        expectedRevision: 4,
      })) as { goal: GoalDto };
      expect(canceled.goal).toMatchObject({
        state: "canceled",
        revision: 5,
      });
      expect(canceled.goal.finishedAt).not.toBeNull();
      expect(harness.inspection.realtimeSignals).toHaveLength(5);
      await expect(
        harness.behavior.callRpc("status", { threadId: "thr_rpc_control" }),
      ).resolves.toEqual({ goal: null });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("resolves current-thread and explicit-thread CLI targets", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    try {
      const currentStart = await harness.behavior.runCli(
        ["start", "Current thread objective"],
        { threadId: "thr_current", cwd: "/workspace" },
      );
      expect(currentStart).toMatchObject({ exitCode: 0 });
      expect(currentStart.stdout).toContain("Thread: thr_current");
      expect(currentStart.stdout).toContain(
        "Objective: Current thread objective",
      );

      const explicitStart = await harness.behavior.runCli(
        ["start", "thr_explicit", "Explicit objective", "--json"],
        { threadId: "thr_current", cwd: "/workspace" },
      );
      expect(explicitStart.exitCode).toBe(0);
      expect(JSON.parse(explicitStart.stdout)).toMatchObject({
        goal: {
          threadId: "thr_explicit",
          objective: "Explicit objective",
        },
      });

      const explicitStatus = await harness.behavior.runCli([
        "status",
        "thr_explicit",
        "--json",
      ]);
      expect(JSON.parse(explicitStatus.stdout)).toMatchObject({
        goal: { threadId: "thr_explicit", state: "active" },
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("controls a Goal through human and JSON CLI routes", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    try {
      await harness.behavior.runCli(["start", "CLI lifecycle"], {
        threadId: "thr_cli_control",
      });

      const edited = await harness.behavior.runCli(
        ["edit", "Redirected from CLI"],
        { threadId: "thr_cli_control" },
      );
      expect(edited).toMatchObject({ exitCode: 0 });
      expect(edited.stdout).toContain("Edited Goal");
      expect(edited.stdout).toContain("Revision: 2");
      expect(edited.stdout).toContain("Objective: Redirected from CLI");

      const paused = await harness.behavior.runCli(["pause", "--json"], {
        threadId: "thr_cli_control",
      });
      expect(JSON.parse(paused.stdout)).toMatchObject({
        goal: { state: "paused", revision: 3 },
      });

      const repeatedPause = await harness.behavior.runCli(
        ["pause", "--json"],
        { threadId: "thr_cli_control" },
      );
      expect(repeatedPause.exitCode).toBe(4);
      expect(JSON.parse(repeatedPause.stderr)).toMatchObject({
        ok: false,
        error: { code: "invalid_transition" },
      });

      const resumed = await harness.behavior.runCli(["resume"], {
        threadId: "thr_cli_control",
      });
      expect(resumed.stdout).toContain("Resumed Goal");
      expect(resumed.stdout).toContain("State: active");

      const canceled = await harness.behavior.runCli(["cancel", "--json"], {
        threadId: "thr_cli_control",
      });
      expect(JSON.parse(canceled.stdout)).toMatchObject({
        goal: { state: "canceled", revision: 5 },
      });

      const repeatedCancel = await harness.behavior.runCli(
        ["cancel", "--json"],
        { threadId: "thr_cli_control" },
      );
      expect(repeatedCancel.exitCode).toBe(3);
      expect(JSON.parse(repeatedCancel.stderr)).toEqual({
        ok: false,
        error: {
          code: "goal_not_found",
          message: "No unfinished Goal for thread thr_cli_control.",
        },
      });
      expect(harness.inspection.realtimeSignals).toHaveLength(5);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("browses, shows, and deliberately deletes Goal history through the CLI", async () => {
    const { bb, harness } = fakeHost();
    await deterministicPlugin()(bb);
    try {
      await harness.behavior.runCli(["start", "first objective"], {
        threadId: "thr_cli_history",
      });
      await harness.behavior.runCli(["cancel"], {
        threadId: "thr_cli_history",
      });
      await harness.behavior.runCli(["start", "second objective"], {
        threadId: "thr_cli_history",
      });

      const firstPage = await harness.behavior.runCli(
        ["history", "--limit", "1", "--json"],
        { threadId: "thr_cli_history" },
      );
      expect(firstPage.exitCode).toBe(0);
      const firstPageJson = JSON.parse(firstPage.stdout) as {
        goals: GoalDto[];
        nextCursor: string | null;
      };
      expect(firstPageJson.goals).toMatchObject([
        { id: "goal_cli_2", objective: "second objective", state: "active" },
      ]);
      expect(firstPageJson.nextCursor).not.toBeNull();

      const secondPage = await harness.behavior.runCli(
        [
          "history",
          "thr_cli_history",
          "--limit=1",
          `--cursor=${firstPageJson.nextCursor}`,
          "--json",
        ],
      );
      const secondPageJson = JSON.parse(secondPage.stdout) as {
        goals: GoalDto[];
        nextCursor: string | null;
      };
      expect(secondPageJson).toMatchObject({
        goals: [{ id: "goal_cli_1", state: "canceled" }],
        nextCursor: null,
      });

      const shown = await harness.behavior.runCli([
        "show",
        "goal_cli_1",
        "--json",
      ]);
      expect(JSON.parse(shown.stdout)).toMatchObject({
        goal: { id: "goal_cli_1", threadId: "thr_cli_history" },
      });

      const unconfirmed = await harness.behavior.runCli([
        "delete",
        "goal_cli_1",
        "--json",
      ]);
      expect(unconfirmed.exitCode).toBe(2);
      expect(JSON.parse(unconfirmed.stderr)).toMatchObject({
        error: { code: "invalid_arguments" },
      });

      const deleted = await harness.behavior.runCli([
        "delete",
        "goal_cli_1",
        "--yes",
      ]);
      expect(deleted.stdout).toContain("Deleted Goal");
      expect(deleted.stdout).toContain("ID: goal_cli_1");

      const status = await harness.behavior.runCli(["status", "--json"], {
        threadId: "thr_cli_history",
      });
      expect(JSON.parse(status.stdout)).toMatchObject({
        goal: { id: "goal_cli_2", objective: "second objective" },
      });
      const missing = await harness.behavior.runCli([
        "show",
        "goal_cli_1",
        "--json",
      ]);
      expect(missing.exitCode).toBe(3);
      expect(JSON.parse(missing.stderr)).toMatchObject({
        error: { code: "goal_not_found" },
      });
      expect(harness.inspection.realtimeSignals).toHaveLength(4);
      expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({
        payload: { goalId: "goal_cli_1", deleted: true },
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("returns stable errors for invalid history limits and cursors", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    try {
      const invalidLimit = await harness.behavior.runCli(
        ["history", "--limit", "101", "--json"],
        { threadId: "thr_history_errors" },
      );
      expect(invalidLimit.exitCode).toBe(2);
      expect(JSON.parse(invalidLimit.stderr)).toMatchObject({
        error: { code: "invalid_arguments" },
      });

      const invalidCursor = await harness.behavior.runCli(
        ["history", "--cursor", "invalid", "--json"],
        { threadId: "thr_history_errors" },
      );
      expect(invalidCursor.exitCode).toBe(2);
      expect(JSON.parse(invalidCursor.stderr)).toEqual({
        ok: false,
        error: {
          code: "invalid_cursor",
          message: "The Goal history cursor is invalid or expired.",
        },
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("exposes guarded history deletion through RPC", async () => {
    const { bb, harness } = fakeHost();
    await deterministicPlugin()(bb);
    try {
      const first = (await harness.behavior.callRpc("start", {
        threadId: "thr_rpc_history",
        objective: "first objective",
      })) as { goal: GoalDto };
      await harness.behavior.callRpc("cancel", {
        threadId: "thr_rpc_history",
        goalId: first.goal.id,
        expectedRevision: 1,
      });
      const second = (await harness.behavior.callRpc("start", {
        threadId: "thr_rpc_history",
        objective: "second objective",
      })) as { goal: GoalDto };

      await expect(
        harness.behavior.callRpc("history", {
          threadId: "thr_rpc_history",
          limit: 20,
          cursor: null,
        }),
      ).resolves.toMatchObject({
        goals: [{ id: second.goal.id }, { id: first.goal.id }],
      });
      await expect(
        harness.behavior.callRpc("delete", {
          threadId: "thr_rpc_history",
          goalId: first.goal.id,
          expectedRevision: 1,
        }),
      ).rejects.toThrow("[stale_goal]");
      await expect(
        harness.behavior.callRpc("delete", {
          threadId: "thr_rpc_history",
          goalId: first.goal.id,
          expectedRevision: 2,
        }),
      ).resolves.toMatchObject({ goal: { id: first.goal.id } });
      await expect(
        harness.behavior.callRpc("status", {
          threadId: "thr_rpc_history",
        }),
      ).resolves.toEqual({ goal: second.goal });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("reads objective-file input through the invoking BB host", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    try {
      const result = await harness.behavior.runCli(
        [
          "start",
          "thr_target",
          "--objective-file",
          "brief.md",
          "--json",
        ],
        { threadId: "thr_invoker", cwd: "/workspace" },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        goal: {
          threadId: "thr_target",
          objective: "Objective read from the invoking machine.",
        },
      });
      expect(harness.inspection.sdk.callsTo("files.read")).toEqual([
        [
          {
            hostId: "host_test",
            path: "/workspace/brief.md",
            signal: undefined,
          },
        ],
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("returns stable human and JSON status output", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    try {
      const empty = await harness.behavior.runCli(["status"], {
        threadId: "thr_output",
      });
      expect(empty).toEqual({
        exitCode: 0,
        stdout: "No unfinished Goal for thread thr_output.\n",
        stderr: "",
      });

      await harness.behavior.runCli(["start", "Output objective"], {
        threadId: "thr_output",
      });
      const human = await harness.behavior.runCli(["status"], {
        threadId: "thr_output",
      });
      expect(human.stdout).toContain("Active Goal\n");
      expect(human.stdout).toContain("State: active");

      const json = await harness.behavior.runCli(["status", "--json"], {
        threadId: "thr_output",
      });
      expect(JSON.parse(json.stdout)).toMatchObject({
        goal: { threadId: "thr_output", objective: "Output objective" },
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rejects missing context and missing threads with non-zero CLI errors", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);
    try {
      const noContext = await harness.behavior.runCli([
        "status",
        "--json",
      ]);
      expect(noContext.exitCode).toBe(2);
      expect(JSON.parse(noContext.stderr)).toEqual({
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "No thread ID was provided and no current BB thread context is available.",
        },
      });

      const missing = await harness.behavior.runCli([
        "status",
        "thr_missing",
        "--json",
      ]);
      expect(missing.exitCode).toBe(3);
      expect(JSON.parse(missing.stderr)).toEqual({
        ok: false,
        error: {
          code: "thread_not_found",
          message: "Thread thr_missing was not found.",
        },
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("disposes one factory-owned Effect runtime before BB closes its handle", async () => {
    const databases: Array<{ open: boolean }> = [];
    let disposalCount = 0;
    const observedPlugin = createPlugin({
      makeRuntime(database, gateway): GoalRuntime {
        databases.push(database);
        const runtime = makeGoalRuntime(database, gateway);
        return {
          run: runtime.run,
          async dispose() {
            expect(database.open).toBe(true);
            disposalCount += 1;
            await runtime.dispose();
            expect(database.open).toBe(true);
          },
        };
      },
    });
    const initial = fakeHost();
    await observedPlugin(initial.bb);

    const reloaded = await initial.harness.lifecycle.reload(observedPlugin);
    expect(disposalCount).toBe(1);
    expect(databases[0]!.open).toBe(false);
    expect(databases[1]!.open).toBe(true);

    await reloaded.harness.lifecycle.dispose();
    expect(disposalCount).toBe(2);
    expect(databases[1]!.open).toBe(false);
  });
});
