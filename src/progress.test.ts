import { describe, expect, it } from "vitest";
import {
  fingerprintAssistantResult,
  observeSettledContinuation,
  type GoalStructuredEventRow,
} from "./progress";

const marker = "bb-goal-continuation:one";

function row(
  seq: number,
  type: string,
  data: unknown,
  scope: GoalStructuredEventRow["scope"] = { kind: "turn", turnId: "turn_1" },
): GoalStructuredEventRow {
  return { id: `event_${seq}`, seq, createdAt: seq, scope, type, data };
}

function settledRows(...middle: GoalStructuredEventRow[]) {
  return [
    row(
      1,
      "client/turn/requested",
      {
        initiator: "system",
        requestId: "request_1",
        target: { kind: "auto", expectedTurnId: null },
        input: [{ type: "text", text: `Internal delivery marker: ${marker}` }],
      },
      { kind: "thread" },
    ),
    row(2, "turn/input/accepted", { clientRequestId: "request_1" }),
    ...middle,
    row(20, "turn/completed", { status: "completed" }),
  ];
}

describe("structured Continuation progress observation", () => {
  it.each([
    [
      "tool-call",
      row(3, "item/started", {
        item: { id: "tool_1", type: "toolCall", tool: "search", status: "pending" },
      }),
    ],
    [
      "file-mutation",
      row(3, "item/completed", {
        item: {
          id: "file_1",
          type: "fileChange",
          status: "completed",
          changes: [{ path: "src/a.ts", kind: "update" }],
        },
      }),
    ],
    [
      "external-action",
      row(3, "item/completed", {
        item: { id: "web_1", type: "webSearch", queries: ["primary source"] },
      }),
    ],
    [
      "pending-interaction",
      row(3, "system/userQuestion/lifecycle", {
        interactionId: "interaction_1",
        status: "pending",
      }),
    ],
  ] as const)("reports %s independently", (expected, event) => {
    expect(observeSettledContinuation(settledRows(event), marker)).toMatchObject({
      requestEventId: "event_1",
      requestId: "request_1",
      turnId: "turn_1",
      terminalEventId: "event_20",
      signals: [expected],
    });
  });

  it("fingerprints the final structured assistant result after normalization", () => {
    const observation = observeSettledContinuation(
      settledRows(
        row(3, "item/completed", {
          item: { id: "message_1", type: "agentMessage", text: " first result " },
        }),
        row(4, "item/completed", {
          item: { id: "message_2", type: "agentMessage", text: "Same\n result" },
        }),
      ),
      marker,
    );
    expect(observation?.assistantResultFingerprint).toBe(
      fingerprintAssistantResult("Same result"),
    );
  });

  it("rejects manual, ambiguous, failed, and cross-turn correlations", () => {
    const manual = settledRows();
    (manual[0]!.data as { initiator: string }).initiator = "user";
    expect(observeSettledContinuation(manual, marker)).toBeNull();
    expect(
      observeSettledContinuation(
        settledRows(
          row(
            20,
            "turn/completed",
            { status: "completed" },
            { kind: "turn", turnId: "old_turn" },
          ),
        ).filter((event) => event.id !== "event_20" || event.scope.kind === "turn" && event.scope.turnId === "old_turn"),
        marker,
      ),
    ).toBeNull();
    expect(
      observeSettledContinuation(
        settledRows().map((event) =>
          event.type === "turn/completed"
            ? { ...event, data: { status: "failed" } }
            : event,
        ),
        marker,
      ),
    ).toBeNull();
  });
});
