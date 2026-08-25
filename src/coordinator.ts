import { randomUUID } from "node:crypto";
import { Context, DateTime, Effect, Layer } from "effect";
import {
  GOAL_HISTORY_MAX_LIMIT,
  GoalGatewayError,
  GoalInvalidBlockage,
  GoalInvalidCompletion,
  GoalInvalidCursor,
  GoalInvalidHistoryQuery,
  GoalInvalidObjective,
  GoalThreadNotFound,
  type GoalCommand,
  type GoalDto,
  type GoalError,
  type GoalHistoryPage,
} from "./domain";
import { decodeGoalHistoryCursor } from "./history-cursor";
import { GoalRepository } from "./repository";

export interface GoalThreadGatewayAdapter {
  readonly threadExists: (threadId: string) => Promise<boolean>;
}

function isRecoverableBlocker(externalAction: string): boolean {
  return /^(?:continue(?: working| debugging)?|debug|investigate|keep trying|try again|none|no blocker|unknown|uncertain)$/i.test(
    externalAction,
  );
}

interface GoalThreadGatewayService {
  readonly requireThread: (
    threadId: string,
  ) => Effect.Effect<void, GoalThreadNotFound | GoalGatewayError>;
}

export class GoalThreadGateway extends Context.Service<
  GoalThreadGateway,
  GoalThreadGatewayService
>()("bb-plugin-goal/GoalThreadGateway") {}

export function makeGoalThreadGatewayLayer(
  adapter: GoalThreadGatewayAdapter,
): Layer.Layer<GoalThreadGateway> {
  return Layer.succeed(
    GoalThreadGateway,
    GoalThreadGateway.of({
      requireThread: Effect.fn("GoalThreadGateway.requireThread")(
        function* (threadId: string) {
          const exists = yield* Effect.tryPromise({
            try: () => adapter.threadExists(threadId),
            catch: (cause) =>
              new GoalGatewayError({
                message: `Could not inspect thread ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
          if (!exists) return yield* new GoalThreadNotFound({ threadId });
        },
      ),
    }),
  );
}

interface GoalIdGeneratorService {
  readonly next: Effect.Effect<string>;
}

export class GoalIdGenerator extends Context.Service<
  GoalIdGenerator,
  GoalIdGeneratorService
>()("bb-plugin-goal/GoalIdGenerator") {}

export const liveGoalIdGeneratorLayer = Layer.succeed(
  GoalIdGenerator,
  GoalIdGenerator.of({
    next: Effect.sync(() => `goal_${randomUUID()}`),
  }),
);

interface GoalClockService {
  readonly nowIso: Effect.Effect<string>;
}

export class GoalClock extends Context.Service<GoalClock, GoalClockService>()(
  "bb-plugin-goal/GoalClock",
) {}

export const liveGoalClockLayer = Layer.succeed(
  GoalClock,
  GoalClock.of({ nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)) }),
);

export type GoalCoordinatorResult =
  | { readonly goal: GoalDto | null }
  | { readonly page: GoalHistoryPage };

interface GoalCoordinatorService {
  readonly execute: (
    command: GoalCommand,
  ) => Effect.Effect<GoalCoordinatorResult, GoalError>;
}

export class GoalCoordinator extends Context.Service<
  GoalCoordinator,
  GoalCoordinatorService
>()("bb-plugin-goal/GoalCoordinator") {
  static readonly layer = Layer.effect(
    GoalCoordinator,
    Effect.gen(function* () {
      const repository = yield* GoalRepository;
      const gateway = yield* GoalThreadGateway;
      const ids = yield* GoalIdGenerator;
      const clock = yield* GoalClock;
      const blockageObservations = new Map<
        string,
        { readonly externalAction: string; readonly repeatedTurns: number }
      >();

      const execute = Effect.fn("GoalCoordinator.execute")(
        function* (command: GoalCommand) {
          if (command.type === "show") {
            return { goal: yield* repository.find(command.goalId) };
          }

          yield* gateway.requireThread(command.threadId);

          if (command.type === "status") {
            return { goal: yield* repository.current(command.threadId) };
          }

          if (command.type === "history") {
            if (
              !Number.isInteger(command.limit) ||
              command.limit < 1 ||
              command.limit > GOAL_HISTORY_MAX_LIMIT
            ) {
              return yield* new GoalInvalidHistoryQuery({
                message: `Goal history limit must be between 1 and ${GOAL_HISTORY_MAX_LIMIT}.`,
              });
            }
            const boundary =
              command.cursor === null
                ? null
                : yield* decodeGoalHistoryCursor(command.cursor);
            if (boundary !== null && boundary.threadId !== command.threadId) {
              return yield* new GoalInvalidCursor({
                message: "The Goal history cursor is invalid or expired.",
              });
            }
            return {
              page: yield* repository.history({
                threadId: command.threadId,
                limit: command.limit,
                boundary,
              }),
            };
          }

          if (command.type === "start") {
            const objective = command.objective.trim();
            if (objective.length === 0) {
              return yield* new GoalInvalidObjective({
                message: "A Goal objective cannot be empty.",
              });
            }

            const id = yield* ids.next;
            const now = yield* clock.nowIso;
            return {
              goal: yield* repository.start({
                id,
                threadId: command.threadId,
                objective,
                now,
              }),
            };
          }

          if (command.type === "delete") {
            return {
              goal: yield* repository.delete({
                threadId: command.threadId,
                goalId: command.goalId,
                expectedRevision: command.expectedRevision,
              }),
            };
          }

          if (command.type === "complete") {
            const summary = command.summary.trim();
            const verificationEvidence = command.verificationEvidence.trim();
            if (summary.length === 0 || verificationEvidence.length === 0) {
              return yield* new GoalInvalidCompletion({
                message:
                  "Goal Completion requires a summary and verification evidence.",
              });
            }
            const now = yield* clock.nowIso;
            return {
              goal: yield* repository.mutate({
                command: { ...command, summary, verificationEvidence },
                now,
              }),
            };
          }

          if (command.type === "block") {
            const externalAction = command.externalAction.trim();
            const evidence = command.evidence.trim();
            if (
              externalAction.length === 0 ||
              evidence.length === 0 ||
              isRecoverableBlocker(externalAction)
            ) {
              return yield* new GoalInvalidBlockage({
                message:
                  "Goal Blockage requires an external action and concrete evidence.",
              });
            }
            const observationKey = `${command.goalId}:${command.expectedRevision}`;
            const previous = blockageObservations.get(observationKey);
            if (
              previous !== undefined &&
              previous.externalAction !== externalAction
            ) {
              return yield* new GoalInvalidBlockage({
                message:
                  "Goal Blockage requires the same external blocker across the reported turns.",
              });
            }
            if (
              !Number.isInteger(command.repeatedTurns) ||
              command.repeatedTurns < 3
            ) {
              blockageObservations.set(observationKey, {
                externalAction,
                repeatedTurns: command.repeatedTurns,
              });
              return yield* new GoalInvalidBlockage({
                message:
                  "Goal Blockage requires at least three consecutive turns with the same blocker.",
              });
            }
            const now = yield* clock.nowIso;
            const result = yield* repository.mutate({
              command: { ...command, externalAction, evidence },
              now,
            });
            blockageObservations.delete(observationKey);
            return { goal: result };
          }

          const guardedCommand =
            command.type === "edit"
              ? {
                  ...command,
                  objective: command.objective.trim(),
                }
              : command;
          if (
            guardedCommand.type === "edit" &&
            guardedCommand.objective.length === 0
          ) {
            return yield* new GoalInvalidObjective({
              message: "A Goal objective cannot be empty.",
            });
          }

          const now = yield* clock.nowIso;
          return {
            goal: yield* repository.mutate({ command: guardedCommand, now }),
          };
        },
      );

      return GoalCoordinator.of({ execute });
    }),
  );
}
