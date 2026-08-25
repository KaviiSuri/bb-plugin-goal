import { z } from "zod";
import {
  type GoalFailure,
  type GoalFailureEventIdentity,
  type GoalUsageLimitKind,
  goalUsageLimitKinds,
} from "./domain";

export interface GoalFailureEvent extends GoalFailureEventIdentity {
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
}

export interface ClassifiedGoalFailure {
  readonly failure: GoalFailure;
  readonly event: GoalFailureEventIdentity | null;
}

const terminalFailureEventTypes = new Set([
  "provider/error",
  "system/error",
]);

const providerErrorData = z
  .object({
    message: z.string().optional(),
    willRetry: z.boolean().optional(),
    errorInfo: z
      .object({
        category: z.string(),
        providerCode: z.string().nullable().optional(),
      })
      .optional(),
  })
  .passthrough();

const rateLimitsData = z
  .object({
    rateLimits: z
      .object({
        kind: z.enum(goalUsageLimitKinds),
        status: z.enum(["allowed", "blocked", "unknown", "warning"]),
        reachedReason: z.string().nullable().optional(),
        windows: z
          .array(
            z
              .object({
                status: z.enum(["allowed", "blocked", "unknown", "warning"]),
                resetsAtMs: z.number().finite().nullable(),
                label: z.string().nullable().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

function usageFailure(
  limitKind: GoalUsageLimitKind,
  reason: string,
  resetAt: string | null,
): GoalFailure {
  return { kind: "usage-limit", limitKind, reason, resetAt };
}

function validResetAt(
  resetsAtMs: number | null | undefined,
  nowMs: number,
): string | null {
  if (resetsAtMs === null || resetsAtMs === undefined || resetsAtMs <= nowMs) {
    return null;
  }
  const resetAt = new Date(resetsAtMs);
  return Number.isNaN(resetAt.getTime()) ? null : resetAt.toISOString();
}

function latestEvent(
  events: readonly GoalFailureEvent[],
  predicate: (event: GoalFailureEvent) => boolean,
): GoalFailureEvent | null {
  return events.reduce<GoalFailureEvent | null>(
    (latest, event) =>
      predicate(event) && (latest === null || event.seq > latest.seq)
        ? event
        : latest,
    null,
  );
}

function blockedRateLimits(
  event: GoalFailureEvent | null,
  nowMs: number,
): { readonly kind: GoalUsageLimitKind; readonly reason: string; readonly resetAt: string | null } | null {
  if (event === null) return null;
  const parsedRate = rateLimitsData.safeParse(event.data);
  if (!parsedRate.success || parsedRate.data.rateLimits.status !== "blocked") {
    return null;
  }
  const rate = parsedRate.data.rateLimits;
  const resetAt = (rate.windows ?? [])
    .map((window) =>
      window.status === "blocked" ? validResetAt(window.resetsAtMs, nowMs) : null,
    )
    .find((candidate): candidate is string => candidate !== null) ?? null;
  return {
    kind: rate.kind,
    reason: rate.reachedReason ?? "Provider usage limit reached.",
    resetAt,
  };
}

/**
 * Classify a failed run as a fact set. A terminal rate-limit error pairs with
 * the latest blocked rate-limit state in the same run; the event kind alone
 * is not a priority and cannot make stale history win.
 */
export function classifyGoalFailureWithIdentity(
  events: readonly GoalFailureEvent[],
  nowMs: number,
  fallbackMessage: string | null = null,
): ClassifiedGoalFailure {
  const terminal = latestEvent(events, (event) =>
    terminalFailureEventTypes.has(event.type),
  );
  const latestRateLimits = latestEvent(
    events,
    (event) => event.type === "provider/rateLimits/updated",
  );
  const blockedRate = blockedRateLimits(latestRateLimits, nowMs);

  if (terminal?.type === "provider/error") {
    const parsedProvider = providerErrorData.safeParse(terminal.data);
    if (parsedProvider.success) {
      const info = parsedProvider.data.errorInfo;
      if (info?.category === "rate-limit" && parsedProvider.data.willRetry !== true) {
        return {
          event: terminal,
          failure:
            blockedRate === null
              ? usageFailure(
                  "unknown",
                  parsedProvider.data.message ?? "Provider rate limit reached.",
                  null,
                )
              : usageFailure(
                  blockedRate.kind,
                  blockedRate.reason,
                  blockedRate.resetAt,
                ),
        };
      }
      const category = info?.category ?? "unknown";
      const code = info?.providerCode === null ? null : info?.providerCode;
      return {
        event: terminal,
        failure: {
          kind: "ordinary",
          source: "provider",
          reason: `Provider ${category}${code === undefined || code === null ? "" : ` (${code})`}: ${parsedProvider.data.message ?? "request failed"}`,
        },
      };
    }
  }

  const systemMessage =
    terminal?.type === "system/error"
      ? z
          .object({ message: z.string().optional() })
          .passthrough()
          .safeParse(terminal.data)
      : null;
  return {
    event: terminal,
    failure: {
      kind: "ordinary",
      source: "turn",
      reason:
        systemMessage?.success && systemMessage.data.message !== undefined
          ? systemMessage.data.message
          : fallbackMessage ?? "The Goal turn failed.",
    },
  };
}

/** Classify structured facts; fallback prose is display-only. */
export function classifyGoalFailure(
  events: readonly GoalFailureEvent[],
  nowMs: number,
  fallbackMessage: string | null = null,
): GoalFailure {
  return classifyGoalFailureWithIdentity(events, nowMs, fallbackMessage).failure;
}
