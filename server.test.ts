import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { createPlugin } from "./server";
import type { GoalDto } from "./src/domain";
import { makeGoalRuntime, type GoalRuntime } from "./src/runtime";

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
      ]);
      expect(harness.inspection.registrations.cli).toMatchObject({
        name: "goal",
        commands: [
          { name: "start" },
          { name: "status" },
          { name: "edit" },
          { name: "pause" },
          { name: "resume" },
          { name: "cancel" },
        ],
      });
    } finally {
      await harness.lifecycle.dispose();
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
