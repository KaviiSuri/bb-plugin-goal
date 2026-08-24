// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";

const activeGoal = {
  id: "goal_ui",
  threadId: "thr_ui",
  objective: "Keep the public path visible while the agent is working",
  state: "active" as const,
  revision: 1,
  createdAt: "2026-08-22T12:00:00.000Z",
  updatedAt: "2026-08-22T12:00:00.000Z",
  finishedAt: null,
};

type RpcHandlers = PluginRpcTestHandlers<typeof rpcContract>;
type Goal = Awaited<ReturnType<RpcHandlers["start"]>>["goal"];

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("./app"));
});

afterAll(() => {
  document.body.innerHTML = "";
});

function goalBanner() {
  const customization = app.composerCustomizations[0];
  if (customization === undefined) throw new Error("Goal row was not registered");
  const banner = customization.banners?.[0];
  if (banner === undefined) throw new Error("Goal banner was not registered");
  return banner;
}

function handlers(initialGoal: Goal | null): RpcHandlers {
  let goal = initialGoal;
  return {
    status: () => ({ goal }),
    start: ({ threadId, objective }) => {
      goal = { ...activeGoal, threadId, objective };
      return { goal };
    },
    edit: ({ objective }) => {
      if (goal === null) throw new Error("missing Goal");
      goal = { ...goal, objective, revision: goal.revision + 1 };
      return { goal };
    },
    pause: () => {
      if (goal === null) throw new Error("missing Goal");
      goal = { ...goal, state: "paused", revision: goal.revision + 1 };
      return { goal };
    },
    resume: () => {
      if (goal === null) throw new Error("missing Goal");
      goal = { ...goal, state: "active", revision: goal.revision + 1 };
      return { goal };
    },
    cancel: () => {
      if (goal === null) throw new Error("missing Goal");
      const canceled = {
        ...goal,
        state: "canceled" as const,
        revision: goal.revision + 1,
        finishedAt: "2026-08-22T12:05:00.000Z",
      };
      goal = null;
      return { goal: canceled };
    },
  };
}

describe("Goal composer row", () => {
  it("is an always-visible thread composer banner with a start path", async () => {
    expect(app.composerCustomizations).toHaveLength(1);
    expect(app.composerCustomizations[0]).toMatchObject({
      id: "goal-row",
      scopes: ["thread"],
      banners: [{ id: "current-goal", chrome: "bare" }],
    });

    const slot = renderSlot<{}, typeof rpcContract>(
      goalBanner(),
      {},
      {
        context: { threadId: "thr_ui", projectId: "proj_ui" },
        rpc: handlers(null),
      },
    );
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Start Goal" }));
      const input = slot.getByRole("textbox", { name: "Goal objective" });
      fireEvent.change(input, { target: { value: "Ship the complete path" } });
      fireEvent.click(slot.getByRole("button", { name: "Start" }));

      expect(await slot.findByText("Active Goal")).toBeTruthy();
      expect(slot.getByText("Ship the complete path")).toBeTruthy();
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "status", input: { threadId: "thr_ui" } },
        {
          method: "start",
          input: {
            threadId: "thr_ui",
            objective: "Ship the complete path",
          },
        },
      ]);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("shows only controls valid for each unfinished Goal state", async () => {
    const slot = renderSlot<{}, typeof rpcContract>(
      goalBanner(),
      {},
      {
        context: { threadId: "thr_ui", projectId: "proj_ui" },
        rpc: handlers(activeGoal),
      },
    );
    try {
      expect(await slot.findByText("Active Goal")).toBeTruthy();
      expect(slot.getByRole("button", { name: "Edit Goal" })).toBeTruthy();
      expect(slot.getByRole("button", { name: "Pause Goal" })).toBeTruthy();
      expect(slot.getByRole("button", { name: "Cancel Goal" })).toBeTruthy();
      expect(slot.queryByRole("button", { name: "Resume Goal" })).toBeNull();

      fireEvent.click(slot.getByRole("button", { name: "Edit Goal" }));
      const editInput = slot.getByRole("textbox", {
        name: "Edit Goal objective",
      });
      expect(editInput.getAttribute("value")).toBe(activeGoal.objective);
      fireEvent.change(editInput, { target: { value: "Redirected objective" } });
      fireEvent.click(slot.getByRole("button", { name: "Save" }));
      expect(await slot.findByText("Redirected objective")).toBeTruthy();

      fireEvent.click(slot.getByRole("button", { name: "Pause Goal" }));
      expect(await slot.findByText("Paused Goal")).toBeTruthy();
      expect(slot.getByRole("button", { name: "Resume Goal" })).toBeTruthy();
      expect(slot.queryByRole("button", { name: "Pause Goal" })).toBeNull();

      fireEvent.click(slot.getByRole("button", { name: "Resume Goal" }));
      expect(await slot.findByText("Active Goal")).toBeTruthy();
      expect(slot.getByRole("button", { name: "Pause Goal" })).toBeTruthy();

      fireEvent.click(slot.getByRole("button", { name: "Cancel Goal" }));
      expect(await slot.findByRole("button", { name: "Start Goal" })).toBeTruthy();
      expect(slot.queryByRole("button", { name: "Cancel Goal" })).toBeNull();

      expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual([
        "status",
        "edit",
        "pause",
        "resume",
        "cancel",
      ]);
      expect(slot.inspection.rpcCalls[1]).toEqual({
        method: "edit",
        input: {
          threadId: "thr_ui",
          goalId: "goal_ui",
          expectedRevision: 1,
          objective: "Redirected objective",
        },
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("limits waiting Goals to edit and cancel controls", async () => {
    const slot = renderSlot<{}, typeof rpcContract>(
      goalBanner(),
      {},
      {
        context: { threadId: "thr_ui", projectId: "proj_ui" },
        rpc: handlers({ ...activeGoal, state: "waiting" }),
      },
    );
    try {
      expect(await slot.findByText("Waiting Goal")).toBeTruthy();
      expect(slot.getByRole("button", { name: "Edit Goal" })).toBeTruthy();
      expect(slot.getByRole("button", { name: "Cancel Goal" })).toBeTruthy();
      expect(slot.queryByRole("button", { name: "Pause Goal" })).toBeNull();
      expect(slot.queryByRole("button", { name: "Resume Goal" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("refreshes after realtime signals and connection recovery", async () => {
    let current: Goal | null = activeGoal;
    const rpc: RpcHandlers = {
      ...handlers(current),
      status: () => ({ goal: current }),
    };

    const slot = renderSlot<{}, typeof rpcContract>(
      goalBanner(),
      {},
      {
        context: { threadId: "thr_ui", projectId: "proj_ui" },
        rpc,
      },
    );
    try {
      expect(await slot.findByText("Active Goal")).toBeTruthy();
      current = { ...activeGoal, state: "paused", revision: 2 };
      await slot.behavior.emitRealtime("goal.changed", {
        threadId: "thr_ui",
        goalId: "goal_ui",
      });
      expect(await slot.findByText("Paused Goal")).toBeTruthy();
      expect(slot.getByRole("button", { name: "Resume Goal" })).toBeTruthy();

      await slot.behavior.setRealtimeConnectionState("reconnecting");
      current = null;
      await slot.behavior.setRealtimeConnectionState("connected");
      expect(await slot.findByRole("button", { name: "Start Goal" })).toBeTruthy();
      expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual([
        "status",
        "status",
        "status",
      ]);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps long objectives available without exposing start controls", async () => {
    const longObjective = `${activeGoal.objective}. `.repeat(12).trim();
    const slot = renderSlot<{}, typeof rpcContract>(
      goalBanner(),
      {},
      {
        context: { threadId: "thr_ui", projectId: "proj_ui" },
        rpc: handlers({ ...activeGoal, objective: longObjective }),
      },
    );
    try {
      expect(await slot.findByText("Active Goal")).toBeTruthy();
      const objective = slot.getByTitle(longObjective);
      expect(objective.textContent).toBe(longObjective);
      expect(slot.queryByRole("button", { name: "Start Goal" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });
});
