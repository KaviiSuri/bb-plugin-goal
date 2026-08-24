import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { createPlugin } from "./server";
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
      ]);
      expect(harness.inspection.registrations.cli).toMatchObject({
        name: "goal",
        commands: [
          { name: "start" },
          { name: "status" },
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
