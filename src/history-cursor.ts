import { Effect, Schema } from "effect";
import { GoalInvalidCursor } from "./domain";

const GoalHistoryCursorPayloadSchema = Schema.Struct({
  version: Schema.Literals([1]),
  threadId: Schema.NonEmptyString,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
});

export interface GoalHistoryBoundary {
  readonly threadId: string;
  readonly sequence: number;
}

const decodePayload = Schema.decodeUnknownSync(GoalHistoryCursorPayloadSchema);

export function encodeGoalHistoryCursor(
  boundary: GoalHistoryBoundary,
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, ...boundary }),
    "utf8",
  ).toString("base64url");
}

export const decodeGoalHistoryCursor = Effect.fn(
  "decodeGoalHistoryCursor",
)((cursor: string) =>
  Effect.try({
    try: (): GoalHistoryBoundary => {
      const bytes = Buffer.from(cursor, "base64url");
      if (bytes.length === 0 || bytes.toString("base64url") !== cursor) {
        throw new Error("Cursor is not canonical base64url.");
      }
      const decoded = decodePayload(JSON.parse(bytes.toString("utf8")));
      return {
        threadId: decoded.threadId,
        sequence: decoded.sequence,
      };
    },
    catch: () =>
      new GoalInvalidCursor({
        message: "The Goal history cursor is invalid or expired.",
      }),
  }),
);
