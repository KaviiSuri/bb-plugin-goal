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

export const goalMutationTypes = ["edit", "pause", "resume", "cancel"] as const;
export type GoalMutationType = (typeof goalMutationTypes)[number];

export const GOAL_HISTORY_DEFAULT_LIMIT = 20;
export const GOAL_HISTORY_MAX_LIMIT = 100;

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

export interface GoalHistoryPage {
  readonly goals: readonly GoalDto[];
  readonly nextCursor: string | null;
}

interface GuardedGoalCommand {
  readonly threadId: string;
  readonly goalId: string;
  readonly expectedRevision: number;
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
    }
  | {
      readonly type: "history";
      readonly threadId: string;
      readonly limit: number;
      readonly cursor: string | null;
    }
  | {
      readonly type: "show";
      readonly goalId: string;
    }
  | (GuardedGoalCommand & {
      readonly type: "edit";
      readonly objective: string;
    })
  | (GuardedGoalCommand & {
      readonly type: "pause" | "resume" | "cancel";
    })
  | (GuardedGoalCommand & {
      readonly type: "delete";
    });

export type GoalMutationCommand = Extract<
  GoalCommand,
  { readonly type: GoalMutationType }
>;

export class GoalAlreadyExists extends Schema.TaggedError<GoalAlreadyExists>()(
  "GoalAlreadyExists",
  {
    threadId: Schema.String,
    goalId: Schema.String,
  },
) {}

export class GoalNotFound extends Schema.TaggedError<GoalNotFound>()(
  "GoalNotFound",
  {
    threadId: Schema.String,
    goalId: Schema.String,
  },
) {}

export class GoalStaleGuard extends Schema.TaggedError<GoalStaleGuard>()(
  "GoalStaleGuard",
  {
    goalId: Schema.String,
    expectedRevision: Schema.Int,
    actualRevision: Schema.Int,
  },
) {}

export class GoalInvalidTransition extends Schema.TaggedError<GoalInvalidTransition>()(
  "GoalInvalidTransition",
  {
    goalId: Schema.String,
    action: Schema.Literals(goalMutationTypes),
    state: Schema.Literals(goalStates),
  },
) {}

export class GoalThreadNotFound extends Schema.TaggedError<GoalThreadNotFound>()(
  "GoalThreadNotFound",
  { threadId: Schema.String },
) {}

export class GoalRecordNotFound extends Schema.TaggedError<GoalRecordNotFound>()(
  "GoalRecordNotFound",
  { goalId: Schema.String },
) {}

export class GoalInvalidCursor extends Schema.TaggedError<GoalInvalidCursor>()(
  "GoalInvalidCursor",
  { message: Schema.String },
) {}

export class GoalInvalidHistoryQuery extends Schema.TaggedError<GoalInvalidHistoryQuery>()(
  "GoalInvalidHistoryQuery",
  { message: Schema.String },
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
  | GoalNotFound
  | GoalStaleGuard
  | GoalInvalidTransition
  | GoalThreadNotFound
  | GoalRecordNotFound
  | GoalInvalidCursor
  | GoalInvalidHistoryQuery
  | GoalInvalidObjective
  | GoalPersistenceError
  | GoalGatewayError;

export type GoalErrorCode =
  | "goal_already_exists"
  | "goal_not_found"
  | "stale_goal"
  | "invalid_transition"
  | "thread_not_found"
  | "invalid_cursor"
  | "invalid_arguments"
  | "invalid_objective"
  | "persistence_error"
  | "gateway_error";

export interface GoalErrorDto {
  readonly code: GoalErrorCode;
  readonly message: string;
}

export type GoalCommandResult =
  | { readonly ok: true; readonly goal: GoalDto | null }
  | { readonly ok: true; readonly page: GoalHistoryPage }
  | { readonly ok: false; readonly error: GoalErrorDto };

export function goalErrorToDto(error: GoalError): GoalErrorDto {
  switch (error._tag) {
    case "GoalAlreadyExists":
      return {
        code: "goal_already_exists",
        message: `Thread ${error.threadId} already has unfinished Goal ${error.goalId}.`,
      };
    case "GoalNotFound":
      return {
        code: "goal_not_found",
        message: `Goal ${error.goalId} was not found on thread ${error.threadId}.`,
      };
    case "GoalStaleGuard":
      return {
        code: "stale_goal",
        message: `Goal ${error.goalId} changed from revision ${error.expectedRevision} to ${error.actualRevision}. Refresh and retry.`,
      };
    case "GoalInvalidTransition":
      return {
        code: "invalid_transition",
        message: `Cannot ${error.action} Goal ${error.goalId} while it is ${error.state}.`,
      };
    case "GoalThreadNotFound":
      return {
        code: "thread_not_found",
        message: `Thread ${error.threadId} was not found.`,
      };
    case "GoalRecordNotFound":
      return {
        code: "goal_not_found",
        message: `Goal ${error.goalId} was not found.`,
      };
    case "GoalInvalidCursor":
      return { code: "invalid_cursor", message: error.message };
    case "GoalInvalidHistoryQuery":
      return { code: "invalid_arguments", message: error.message };
    case "GoalInvalidObjective":
      return { code: "invalid_objective", message: error.message };
    case "GoalPersistenceError":
      return { code: "persistence_error", message: error.message };
    case "GoalGatewayError":
      return { code: "gateway_error", message: error.message };
  }
}
