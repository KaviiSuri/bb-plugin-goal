// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
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
  completionSummary: null,
  verificationEvidence: null,
  blockageExternalAction: null,
  blockageEvidence: null,
  blockageRepeatedTurns: null,
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

function historyPanel() {
  const panel = app.threadPanelActions[0];
  if (panel === undefined) throw new Error("Goal history panel was not registered");
  return panel;
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
    history: () => ({
      goals: goal === null ? [] : [goal],
      nextCursor: null,
    }),
    show: ({ goalId }) => {
      if (goal === null || goal.id !== goalId) throw new Error("missing Goal");
      return { goal };
    },
    delete: ({ goalId, expectedRevision }) => {
      if (
        goal === null ||
        goal.id !== goalId ||
        goal.revision !== expectedRevision
      ) {
        throw new Error("stale Goal");
      }
      const deleted = goal;
      goal = null;
      return { goal: deleted };
    },
  };
}

describe("Goal composer row", () => {
  it("is an always-visible thread composer banner with a start path", async () => {
    expect(app.composerCustomizations).toHaveLength(1);
    expect(app.threadPanelActions).toMatchObject([
      { id: "history", title: "Goal history", icon: "History" },
    ]);
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
        openThreadPanel: () => true,
      },
    );
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Start Goal" }));
      const input = slot.getByRole("textbox", { name: "Goal objective" });
      fireEvent.change(input, { target: { value: "Ship the complete path" } });
      fireEvent.click(slot.getByRole("button", { name: "Start" }));

      expect(await slot.findByText("Active Goal")).toBeTruthy();
      expect(slot.getByText("Ship the complete path")).toBeTruthy();
      fireEvent.click(slot.getByRole("button", { name: "History" }));
      expect(slot.inspection.navigateCalls).toEqual([
        {
          method: "openThreadPanel",
          options: { actionId: "history", title: "Goal history" },
        },
      ]);
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

  it("paginates panel history, confirms exact deletion, and refreshes realtime", async () => {
    const historical: Goal = {
      ...activeGoal,
      id: "goal_old",
      objective: "Finished historical objective",
      state: "canceled",
      revision: 3,
      finishedAt: "2026-08-22T11:00:00.000Z",
    };
    let goals: Goal[] = [activeGoal, historical];
    const rpc: RpcHandlers = {
      ...handlers(activeGoal),
      history: ({ cursor }) => ({
        goals: cursor === null ? goals.slice(0, 1) : goals.slice(1),
        nextCursor: cursor === null && goals.length > 1 ? "older" : null,
      }),
      delete: ({ threadId, goalId, expectedRevision }) => {
        const goal = goals.find((candidate) => candidate.id === goalId);
        if (
          goal === undefined ||
          goal.threadId !== threadId ||
          goal.revision !== expectedRevision
        ) {
          throw new Error("stale Goal");
        }
        goals = goals.filter((candidate) => candidate.id !== goalId);
        return { goal };
      },
    };

    const slot = renderSlot<
      { threadId: string; params: JsonValue | null },
      typeof rpcContract
    >(
      historyPanel(),
      { threadId: "thr_ui", params: null },
      { rpc },
    );
    try {
      expect(await slot.findByText(activeGoal.objective)).toBeTruthy();
      fireEvent.click(
        slot.getByRole("button", { name: "Load older Goals" }),
      );
      expect(await slot.findByText(historical.objective)).toBeTruthy();

      const deleteButtons = slot.getAllByRole("button", { name: "Delete" });
      fireEvent.click(deleteButtons[1]!);
      expect(slot.getByText("Delete this Goal permanently?")).toBeTruthy();
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "delete"),
      ).toHaveLength(0);
      fireEvent.click(slot.getByRole("button", { name: "Confirm delete" }));
      await waitFor(() => {
        expect(slot.queryByText(historical.objective)).toBeNull();
      });
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "delete"),
      ).toEqual([
        {
          method: "delete",
          input: {
            threadId: "thr_ui",
            goalId: "goal_old",
            expectedRevision: 3,
          },
        },
      ]);

      goals = [
        {
          ...activeGoal,
          objective: "Updated outside the panel",
          revision: 2,
        },
      ];
      await slot.behavior.emitRealtime("goal.changed", {
        threadId: "thr_ui",
        goalId: "goal_ui",
        revision: 2,
      });
      expect(await slot.findByText("Updated outside the panel")).toBeTruthy();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("shows Completion summary and verification evidence in history", async () => {
    const completed: Goal = {
      ...activeGoal,
      state: "completed",
      revision: 2,
      finishedAt: "2026-08-22T12:05:00.000Z",
      completionSummary: "Implemented the guarded Completion path.",
      verificationEvidence: "Coordinator, fake-host, and UI tests pass.",
    };
    const slot = renderSlot<
      { threadId: string; params: JsonValue | null },
      typeof rpcContract
    >(
      historyPanel(),
      { threadId: "thr_ui", params: null },
      { rpc: handlers(completed) },
    );
    try {
      expect(await slot.findByText("Completed Goal")).toBeTruthy();
      expect(slot.getByText(completed.completionSummary!)).toBeTruthy();
      expect(slot.getByText(completed.verificationEvidence!)).toBeTruthy();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("shows external action and evidence for a blocked Goal", async () => {
    const blocked: Goal = {
      ...activeGoal,
      state: "blocked",
      revision: 2,
      finishedAt: "2026-08-22T12:05:00.000Z",
      blockageExternalAction: "User must provide a credential",
      blockageEvidence: "The provider rejected all three attempts.",
      blockageRepeatedTurns: 3,
    };
    const slot = renderSlot<
      { threadId: string; params: JsonValue | null },
      typeof rpcContract
    >(historyPanel(), { threadId: "thr_ui", params: null }, {
      rpc: handlers(blocked),
    });
    try {
      expect(await slot.findByText("Blocked Goal")).toBeTruthy();
      expect(slot.getByText("User must provide a credential")).toBeTruthy();
      expect(slot.getByText("The provider rejected all three attempts.")).toBeTruthy();
      expect(slot.getByText(/Same blocker reported for 3 Goal turns/)).toBeTruthy();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("renders panel empty and error states", async () => {
    const empty = renderSlot<
      { threadId: string; params: JsonValue | null },
      typeof rpcContract
    >(
      historyPanel(),
      { threadId: "thr_ui", params: null },
      { rpc: handlers(null) },
    );
    try {
      expect(empty.getByText("Loading Goal history")).toBeTruthy();
      expect(
        await empty.findByText("No Goals have been recorded for this thread."),
      ).toBeTruthy();
    } finally {
      empty.lifecycle.unmount();
    }

    const failing: RpcHandlers = {
      ...handlers(null),
      history: () => {
        throw new Error("History is temporarily unavailable");
      },
    };
    const errored = renderSlot<
      { threadId: string; params: JsonValue | null },
      typeof rpcContract
    >(
      historyPanel(),
      { threadId: "thr_ui", params: null },
      { rpc: failing },
    );
    try {
      expect(
        await errored.findByText("History is temporarily unavailable"),
      ).toBeTruthy();
      expect(errored.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      errored.lifecycle.unmount();
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
