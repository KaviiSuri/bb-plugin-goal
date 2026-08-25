import { z } from "zod";
import {
  type GoalFailure,
  type GoalUsageLimitKind,
  goalUsageLimitKinds,
} from "./domain";

export interface GoalFailureEvent {
  readonly type: string;
  readonly data: unknown;
}

const providerErrorData = z
  .object({
    message: z.string().optional(),
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

/**
 * Classify only structured provider events. The thread.failed prose is used as
 * a fallback for display, never to decide whether a usage limit is present.
 */
export function classifyGoalFailure(
  events: readonly GoalFailureEvent[],
  nowMs: number,
  fallbackMessage: string | null = null,
): GoalFailure {
  const rateEvent = events.find((event) => event.type === "provider/rateLimits/updated");
  const parsedRate = rateEvent === undefined ? null : rateLimitsData.safeParse(rateEvent.data);
  if (parsedRate?.success && parsedRate.data.rateLimits.status === "blocked") {
    const rate = parsedRate.data.rateLimits;
    const resetAt = (rate.windows ?? [])
      .map((window) =>
        window.status === "blocked"
          ? validResetAt(window.resetsAtMs, nowMs)
          : null,
      )
      .find((candidate): candidate is string => candidate !== null) ?? null;
    return usageFailure(
      rate.kind,
      rate.reachedReason ?? "Provider usage limit reached.",
      resetAt,
    );
  }

  const providerEvent = events.find((event) => event.type === "provider/error");
  const parsedProvider =
    providerEvent === undefined
      ? null
      : providerErrorData.safeParse(providerEvent.data);
  if (parsedProvider?.success) {
    const info = parsedProvider.data.errorInfo;
    if (info?.category === "rate-limit") {
      return usageFailure(
        "unknown",
        parsedProvider.data.message ?? "Provider rate limit reached.",
        null,
      );
    }
    const category = info?.category ?? "unknown";
    const code = info?.providerCode === null ? null : info?.providerCode;
    return {
      kind: "ordinary",
      source: "provider",
      reason: `Provider ${category}${code === undefined || code === null ? "" : ` (${code})`}: ${parsedProvider.data.message ?? "request failed"}`,
    };
  }

  const systemEvent = events.find((event) => event.type === "system/error");
  const systemMessage =
    systemEvent === undefined
      ? null
      : z
          .object({ message: z.string().optional() })
          .passthrough()
          .safeParse(systemEvent.data);
  return {
    kind: "ordinary",
    source: "turn",
    reason:
      systemMessage?.success && systemMessage.data.message !== undefined
        ? systemMessage.data.message
        : fallbackMessage ?? "The Goal turn failed.",
  };
}
