import { Schema } from "effect";

export const goalStates = [
  "active",
  "paused",
  "waiting",
  "completed",
  "blocked",
  "canceled",
] as const;

export type GoalState = (typeof goalStates)[number];

export const GoalDtoSchema = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  objective: Schema.String,
  state: Schema.Literals(goalStates),
  revision: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});

export interface GoalDto {
  readonly id: string;
  readonly threadId: string;
  readonly objective: string;
  readonly state: GoalState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export type GoalCommand =
  | {
      readonly type: "start";
      readonly threadId: string;
      readonly objective: string;
    }
  | {
      readonly type: "status";
      readonly threadId: string;
    };

export class GoalAlreadyExists extends Schema.TaggedError<GoalAlreadyExists>()(
  "GoalAlreadyExists",
  {
    threadId: Schema.String,
    goalId: Schema.String,
  },
) {}

export class GoalThreadNotFound extends Schema.TaggedError<GoalThreadNotFound>()(
  "GoalThreadNotFound",
  { threadId: Schema.String },
) {}

export class GoalInvalidObjective extends Schema.TaggedError<GoalInvalidObjective>()(
  "GoalInvalidObjective",
  { message: Schema.String },
) {}

export class GoalPersistenceError extends Schema.TaggedError<GoalPersistenceError>()(
  "GoalPersistenceError",
  { message: Schema.String },
) {}

export class GoalGatewayError extends Schema.TaggedError<GoalGatewayError>()(
  "GoalGatewayError",
  { message: Schema.String },
) {}

export type GoalError =
  | GoalAlreadyExists
  | GoalThreadNotFound
  | GoalInvalidObjective
  | GoalPersistenceError
  | GoalGatewayError;

export type GoalErrorCode =
  | "goal_already_exists"
  | "thread_not_found"
  | "invalid_objective"
  | "persistence_error"
  | "gateway_error";

export interface GoalErrorDto {
  readonly code: GoalErrorCode;
  readonly message: string;
}

export type GoalCommandResult =
  | { readonly ok: true; readonly goal: GoalDto | null }
  | { readonly ok: false; readonly error: GoalErrorDto };

export function goalErrorToDto(error: GoalError): GoalErrorDto {
  switch (error._tag) {
    case "GoalAlreadyExists":
      return {
        code: "goal_already_exists",
        message: `Thread ${error.threadId} already has unfinished Goal ${error.goalId}.`,
      };
    case "GoalThreadNotFound":
      return {
        code: "thread_not_found",
        message: `Thread ${error.threadId} was not found.`,
      };
    case "GoalInvalidObjective":
      return { code: "invalid_objective", message: error.message };
    case "GoalPersistenceError":
      return { code: "persistence_error", message: error.message };
    case "GoalGatewayError":
      return { code: "gateway_error", message: error.message };
  }
}
