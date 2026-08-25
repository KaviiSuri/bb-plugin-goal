import { describe, expect, it } from "vitest";
import {
  classifyGoalFailure,
  classifyGoalFailureWithIdentity,
} from "./failure";

describe("structured Goal failure classification", () => {
  it("pairs a terminal rate-limit error with blocked thread rate state", () => {
    expect(
      classifyGoalFailure(
        [
          {
            id: "event-rate-subscription",
            seq: 2,
            createdAt: Date.parse("2026-08-22T12:01:00.000Z"),
            type: "provider/rateLimits/updated",
            data: {
              rateLimits: {
                kind: "subscription-window",
                status: "blocked",
                reachedReason: "subscription window exhausted",
                windows: [
                  {
                    status: "blocked",
                    label: "session",
                    resetsAtMs: Date.parse("2026-08-22T12:05:00.000Z"),
                  },
                  {
                    status: "blocked",
                    label: "weekly",
                    resetsAtMs: Date.parse("2026-08-22T13:05:00.000Z"),
                  },
                ],
              },
            },
          },
          {
            id: "event-terminal-rate-error",
            seq: 3,
            createdAt: Date.parse("2026-08-22T12:01:01.000Z"),
            type: "provider/error",
            data: {
              message: "terminal provider rate limit",
              errorInfo: { category: "rate-limit", providerCode: null },
            },
          },
        ],
        Date.parse("2026-08-22T12:00:00.000Z"),
        "assistant prose that looks like a credit limit",
      ),
    ).toEqual({
      kind: "usage-limit",
      limitKind: "subscription-window",
      reason: "subscription window exhausted",
      resetAt: "2026-08-22T13:05:00.000Z",
    });
  });

  it("does not schedule recovery when a blocked window has no trustworthy reset", () => {
    expect(
      classifyGoalFailure(
        [
          {
            id: "event-rate-untrustworthy",
            seq: 2,
            createdAt: Date.parse("2026-08-22T12:01:00.000Z"),
            type: "provider/rateLimits/updated",
            data: {
              rateLimits: {
                kind: "subscription-window",
                status: "blocked",
                reachedReason: "multiple windows blocked",
                windows: [
                  {
                    status: "blocked",
                    resetsAtMs: Date.parse("2026-08-22T12:05:00.000Z"),
                  },
                  { status: "blocked", resetsAtMs: null },
                ],
              },
            },
          },
          {
            id: "event-terminal-untrustworthy-rate-error",
            seq: 3,
            createdAt: Date.parse("2026-08-22T12:01:01.000Z"),
            type: "provider/error",
            data: {
              message: "terminal provider rate limit",
              errorInfo: { category: "rate-limit", providerCode: null },
            },
          },
        ],
        Date.parse("2026-08-22T12:00:00.000Z"),
      ),
    ).toEqual({
      kind: "usage-limit",
      limitKind: "subscription-window",
      reason: "multiple windows blocked",
      resetAt: null,
    });
  });

  it("classifies the newest failure by sequence instead of stale event kind priority", () => {
    expect(
      classifyGoalFailure(
        [
          {
            id: "old-rate-limit",
            seq: 10,
            createdAt: Date.parse("2026-08-22T12:00:10.000Z"),
            type: "provider/rateLimits/updated",
            data: {
              rateLimits: {
                kind: "subscription-window",
                status: "blocked",
                reachedReason: "old limit",
                windows: [],
              },
            },
          },
          {
            id: "new-provider-error",
            seq: 11,
            createdAt: Date.parse("2026-08-22T12:00:11.000Z"),
            type: "provider/error",
            data: {
              message: "new ordinary failure",
              errorInfo: { category: "server-error", providerCode: null },
            },
          },
        ],
        Date.parse("2026-08-22T12:01:00.000Z"),
      ),
    ).toMatchObject({
      kind: "ordinary",
      source: "provider",
      reason: expect.stringContaining("new ordinary failure"),
    });
  });

  it("classifies a fallback when no structured event belongs to the failed run", () => {
    expect(
      classifyGoalFailureWithIdentity(
        [],
        Date.parse("2026-08-22T12:01:00.000Z"),
        "current fallback failure",
      ),
    ).toEqual({
      event: null,
      failure: {
        kind: "ordinary",
        source: "turn",
        reason: "current fallback failure",
      },
    });
  });

  it("requires a reset from structured data and leaves credits manual", () => {
    expect(
      classifyGoalFailure(
        [
          {
            id: "event-rate-credits",
            seq: 4,
            createdAt: Date.parse("2026-08-22T12:02:00.000Z"),
            type: "provider/rateLimits/updated",
            data: {
              rateLimits: {
                kind: "credits",
                status: "blocked",
                reachedReason: "credits exhausted",
                windows: [],
              },
            },
          },
          {
            id: "event-terminal-credits-error",
            seq: 5,
            createdAt: Date.parse("2026-08-22T12:02:01.000Z"),
            type: "provider/error",
            data: {
              message: "credits exhausted",
              errorInfo: { category: "rate-limit", providerCode: null },
            },
          },
        ],
        Date.parse("2026-08-22T12:00:00.000Z"),
        null,
      ),
    ).toEqual({
      kind: "usage-limit",
      limitKind: "credits",
      reason: "credits exhausted",
      resetAt: null,
    });
  });

  it("maps an ordinary structured provider error without treating prose as usage", () => {
    expect(
      classifyGoalFailure(
        [
          {
            id: "event-provider-error",
            seq: 6,
            createdAt: Date.parse("2026-08-22T12:03:00.000Z"),
            type: "provider/error",
            data: {
              message: "The provider connection was refused.",
              errorInfo: {
                category: "connection-failed",
                providerCode: "ECONNRESET",
              },
            },
          },
        ],
        Date.parse("2026-08-22T12:00:00.000Z"),
        "not used for classification",
      ),
    ).toEqual({
      kind: "ordinary",
      source: "provider",
      reason:
        "Provider connection-failed (ECONNRESET): The provider connection was refused.",
    });
  });
});
