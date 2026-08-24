// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
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
        rpc: {
          status: () => ({ goal: null }),
          start: ({ threadId, objective }) => ({
            goal: { ...activeGoal, threadId, objective },
          }),
        },
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

  it("shows the current Goal objective on every mount", async () => {
    const longObjective = `${activeGoal.objective}. `.repeat(12).trim();
    const slot = renderSlot<{}, typeof rpcContract>(
      goalBanner(),
      {},
      {
        context: { threadId: "thr_ui", projectId: "proj_ui" },
        rpc: {
          status: () => ({
            goal: { ...activeGoal, objective: longObjective },
          }),
          start: () => ({ goal: activeGoal }),
        },
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
