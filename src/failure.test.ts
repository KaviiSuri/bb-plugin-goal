import { describe, expect, it } from "vitest";
import { classifyGoalFailure } from "./failure";

describe("structured Goal failure classification", () => {
  it("uses a structured subscription window reset and ignores failure prose", () => {
    expect(
      classifyGoalFailure(
        [
          {
            type: "provider/rateLimits/updated",
            data: {
              rateLimits: {
                kind: "subscription-window",
                status: "blocked",
                reachedReason: "subscription window exhausted",
                windows: [
                  {
                    status: "blocked",
                    resetsAtMs: Date.parse("2026-08-22T12:05:00.000Z"),
                  },
                ],
              },
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
      resetAt: "2026-08-22T12:05:00.000Z",
    });
  });

  it("requires a reset from structured data and leaves credits manual", () => {
    expect(
      classifyGoalFailure(
        [
          {
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
