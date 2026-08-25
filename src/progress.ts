import { createHash } from "node:crypto";
import type { GoalProgressSignalKind } from "./domain";

export interface GoalStructuredEventRow {
  readonly id: string;
  readonly seq: number;
  readonly createdAt: number;
  readonly scope: { readonly kind: "thread" } | { readonly kind: "turn"; readonly turnId: string };
  readonly type: string;
  readonly data: unknown;
}

export interface GoalSettledContinuationObservation {
  readonly requestEventId: string;
  readonly requestSeq: number;
  readonly requestId: string;
  readonly acceptedEventId: string;
  readonly acceptedSeq: number;
  readonly turnId: string;
  readonly terminalEventId: string;
  readonly terminalSeq: number;
  readonly signals: readonly Exclude<GoalProgressSignalKind, "changed-assistant-result">[];
  readonly assistantResultFingerprint: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function markerIsInInput(data: unknown, marker: string): boolean {
  const input = record(data)?.input;
  return (
    Array.isArray(input) &&
    input.some((part) => {
      const item = record(part);
      return (
        item?.type === "text" &&
        typeof item.text === "string" &&
        item.text.includes(marker)
      );
    })
  );
}

export function continuationPrompt(deliveryMarker: string): string {
  return (
    "Continue working toward the active BB Goal. Re-read the objective and make the next meaningful step. Do not stop unless the Goal is complete or genuinely blocked. " +
    `Internal delivery marker: ${deliveryMarker}`
  );
}

export function fingerprintAssistantResult(text: string): string {
  const normalized = text.normalize("NFKC").trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

export function observeSettledContinuation(
  rows: readonly GoalStructuredEventRow[],
  deliveryMarker: string,
): GoalSettledContinuationObservation | null {
  const ordered = [...rows].sort((left, right) => left.seq - right.seq);
  const request = ordered.find((row) => {
    if (row.type !== "client/turn/requested") return false;
    const data = record(row.data);
    const target = record(data?.target);
    return (
      data?.initiator === "system" &&
      target?.kind === "auto" &&
      typeof data.requestId === "string" &&
      markerIsInInput(data, deliveryMarker)
    );
  });
  if (request === undefined) return null;
  const requestId = record(request.data)?.requestId;
  if (typeof requestId !== "string") return null;

  const accepted = ordered.find((row) => {
    const data = record(row.data);
    return (
      row.seq > request.seq &&
      row.type === "turn/input/accepted" &&
      row.scope.kind === "turn" &&
      data?.clientRequestId === requestId
    );
  });
  if (accepted === undefined || accepted.scope.kind !== "turn") return null;
  const turnId = accepted.scope.turnId;
  const terminal = ordered.find((row) => {
    const data = record(row.data);
    return (
      row.seq > accepted.seq &&
      row.type === "turn/completed" &&
      row.scope.kind === "turn" &&
      row.scope.turnId === turnId &&
      data?.status === "completed"
    );
  });
  if (terminal === undefined) return null;

  const turnRows = ordered.filter(
    (row) =>
      row.seq > accepted.seq &&
      row.seq < terminal.seq &&
      row.scope.kind === "turn" &&
      row.scope.turnId === turnId,
  );
  const signals = new Set<Exclude<GoalProgressSignalKind, "changed-assistant-result">>();
  let assistantResultFingerprint: string | null = null;
  for (const row of turnRows) {
    const data = record(row.data);
    const item = record(data?.item);
    if (
      (row.type === "item/started" || row.type === "item/completed") &&
      (item?.type === "commandExecution" || item?.type === "toolCall")
    ) {
      signals.add("tool-call");
    }
    if (
      ((row.type === "item/started" || row.type === "item/completed") &&
        item?.type === "fileChange" &&
        Array.isArray(item.changes) &&
        item.changes.length > 0) ||
      (row.type === "turn/diff/updated" &&
        typeof data?.diff === "string" &&
        data.diff.length > 0)
    ) {
      signals.add("file-mutation");
    }
    if (
      (row.type === "item/started" || row.type === "item/completed") &&
      ["webSearch", "webFetch", "imageView", "backgroundTask"].includes(
        String(item?.type),
      )
    ) {
      signals.add("external-action");
    }
    if (
      (row.type === "system/permissionGrant/lifecycle" ||
        row.type === "system/userQuestion/lifecycle") &&
      data?.status === "pending"
    ) {
      signals.add("pending-interaction");
    }
    if (
      row.type === "item/completed" &&
      item?.type === "agentMessage" &&
      typeof item.text === "string"
    ) {
      assistantResultFingerprint = fingerprintAssistantResult(item.text);
    }
  }

  return {
    requestEventId: request.id,
    requestSeq: request.seq,
    requestId,
    acceptedEventId: accepted.id,
    acceptedSeq: accepted.seq,
    turnId,
    terminalEventId: terminal.id,
    terminalSeq: terminal.seq,
    signals: [...signals],
    assistantResultFingerprint,
  };
}
