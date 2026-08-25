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

const failureEventTypes = new Set([
  "provider/error",
  "provider/rateLimits/updated",
  "system/error",
]);

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

function latestFailureEvent(
  events: readonly GoalFailureEvent[],
): GoalFailureEvent | null {
  return (
    events
      .filter((event) => failureEventTypes.has(event.type))
      .reduce<GoalFailureEvent | null>(
        (latest, event) =>
          latest === null || event.seq > latest.seq ? event : latest,
        null,
      ) ?? null
  );
}

/**
 * Classify the newest structured failure event by its durable sequence. The
 * event kind is deliberately not a priority: an older rate-limit event must
 * not override a newer ordinary provider error.
 */
export function classifyGoalFailureWithIdentity(
  events: readonly GoalFailureEvent[],
  nowMs: number,
  fallbackMessage: string | null = null,
  lifecycleCreatedAtMs: number | null = null,
): ClassifiedGoalFailure {
  const structuredEvent = latestFailureEvent(events);
  const event =
    fallbackMessage !== null &&
    lifecycleCreatedAtMs !== null &&
    structuredEvent !== null &&
    structuredEvent.createdAt < lifecycleCreatedAtMs
      ? null
      : structuredEvent;
  if (event?.type === "provider/rateLimits/updated") {
    const parsedRate = rateLimitsData.safeParse(event.data);
    if (parsedRate.success && parsedRate.data.rateLimits.status === "blocked") {
      const rate = parsedRate.data.rateLimits;
      const resetAt = (rate.windows ?? [])
        .map((window) =>
          window.status === "blocked"
            ? validResetAt(window.resetsAtMs, nowMs)
            : null,
        )
        .find((candidate): candidate is string => candidate !== null) ?? null;
      return {
        event,
        failure: usageFailure(
          rate.kind,
          rate.reachedReason ?? "Provider usage limit reached.",
          resetAt,
        ),
      };
    }
  }

  if (event?.type === "provider/error") {
    const parsedProvider = providerErrorData.safeParse(event.data);
    if (parsedProvider.success) {
      const info = parsedProvider.data.errorInfo;
      if (info?.category === "rate-limit") {
        return {
          event,
          failure: usageFailure(
            "unknown",
            parsedProvider.data.message ?? "Provider rate limit reached.",
            null,
          ),
        };
      }
      const category = info?.category ?? "unknown";
      const code = info?.providerCode === null ? null : info?.providerCode;
      return {
        event,
        failure: {
          kind: "ordinary",
          source: "provider",
          reason: `Provider ${category}${code === undefined || code === null ? "" : ` (${code})`}: ${parsedProvider.data.message ?? "request failed"}`,
        },
      };
    }
  }

  const systemMessage =
    event?.type === "system/error"
      ? z
          .object({ message: z.string().optional() })
          .passthrough()
          .safeParse(event.data)
      : null;
  return {
    event,
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

/** Classify only structured provider events; prose is display-only fallback. */
export function classifyGoalFailure(
  events: readonly GoalFailureEvent[],
  nowMs: number,
  fallbackMessage: string | null = null,
): GoalFailure {
  return classifyGoalFailureWithIdentity(events, nowMs, fallbackMessage).failure;
}
