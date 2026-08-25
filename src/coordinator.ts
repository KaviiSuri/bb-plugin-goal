import { randomUUID } from "node:crypto";
import { Context, DateTime, Duration, Effect, Layer } from "effect";
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
import {
  GoalRepository,
  type GoalContinuationRecord,
} from "./repository";

export interface GoalThreadSnapshot {
  readonly status: string;
}

export interface GoalThreadGatewayAdapter {
  readonly threadExists: (threadId: string) => Promise<boolean>;
  readonly readThread?: (
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<GoalThreadSnapshot>;
  readonly sendContinuation?: (
    threadId: string,
    deliveryMarker: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly reconcileContinuation?: (
    threadId: string,
    deliveryMarker: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
}

export function goalContinuationMarker(continuationId: string): string {
  return `bb-goal-continuation:${continuationId}`;
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
  readonly readThread: (
    threadId: string,
    signal?: AbortSignal,
  ) => Effect.Effect<GoalThreadSnapshot, GoalGatewayError>;
  readonly sendContinuation: (
    threadId: string,
    deliveryMarker: string,
    signal?: AbortSignal,
  ) => Effect.Effect<void, GoalGatewayError>;
  readonly reconcileContinuation: (
    threadId: string,
    deliveryMarker: string,
    signal?: AbortSignal,
  ) => Effect.Effect<boolean, GoalGatewayError>;
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
      readThread: Effect.fn("GoalThreadGateway.readThread")(
        function* (threadId: string, signal?: AbortSignal) {
          if (adapter.readThread === undefined) {
            return yield* new GoalGatewayError({
              message: "The BB thread gateway cannot read thread state.",
            });
          }
          return yield* Effect.tryPromise({
            try: () => adapter.readThread!(threadId, signal),
            catch: (cause) =>
              new GoalGatewayError({
                message: `Could not read thread ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
        },
      ),
      sendContinuation: Effect.fn("GoalThreadGateway.sendContinuation")(
        function* (
          threadId: string,
          deliveryMarker: string,
          signal?: AbortSignal,
        ) {
          if (adapter.sendContinuation === undefined) {
            return yield* new GoalGatewayError({
              message: "The BB thread gateway cannot send a Continuation.",
            });
          }
          return yield* Effect.tryPromise({
            try: () =>
              adapter.sendContinuation!(threadId, deliveryMarker, signal),
            catch: (cause) =>
              new GoalGatewayError({
                message: `Could not send a Continuation for thread ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
        },
      ),
      reconcileContinuation: Effect.fn(
        "GoalThreadGateway.reconcileContinuation",
      )(
        function* (
          threadId: string,
          deliveryMarker: string,
          signal?: AbortSignal,
        ) {
          if (adapter.reconcileContinuation === undefined) return false;
          return yield* Effect.tryPromise({
            try: () =>
              adapter.reconcileContinuation!(threadId, deliveryMarker, signal),
            catch: (cause) =>
              new GoalGatewayError({
                message: `Could not reconcile Continuation for thread ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
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

export const GOAL_CONTINUATION_LEASE_SECONDS = 30;

export interface GoalContinuationRequest {
  readonly threadId: string;
  readonly opportunityKey: string;
}

export type GoalContinuationProcessResult =
  | { readonly kind: "idle" }
  | { readonly kind: "sent"; readonly continuation: GoalContinuationRecord }
  | { readonly kind: "released"; readonly continuation: GoalContinuationRecord };

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
              isRecoverableBlocker(externalAction) ||
              !Number.isInteger(command.repeatedTurns) ||
              command.repeatedTurns < 1
            ) {
              return yield* new GoalInvalidBlockage({
                message:
                  "Goal Blockage requires an external action, concrete evidence, and a positive consecutive-turn count.",
              });
            }
            const now = yield* clock.nowIso;
            return {
              goal: yield* repository.mutate({
                command: { ...command, externalAction, evidence },
                now,
              }),
            };
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

interface GoalContinuationCoordinatorService {
  readonly enqueueIdle: (
    request: GoalContinuationRequest,
  ) => Effect.Effect<GoalContinuationRecord | null, GoalError>;
  readonly recover: () => Effect.Effect<void, GoalError>;
  readonly process: (
    signal?: AbortSignal,
  ) => Effect.Effect<GoalContinuationProcessResult, GoalError>;
}

export class GoalContinuationCoordinator extends Context.Service<
  GoalContinuationCoordinator,
  GoalContinuationCoordinatorService
>()("bb-plugin-goal/GoalContinuationCoordinator") {
  static readonly layer = Layer.effect(
    GoalContinuationCoordinator,
    Effect.gen(function* () {
      const repository = yield* GoalRepository;
      const gateway = yield* GoalThreadGateway;
      const ids = yield* GoalIdGenerator;
      const clock = yield* GoalClock;

      const nowAndLease = Effect.gen(function* () {
        const now = yield* clock.nowIso;
        const leaseExpiresAt = DateTime.formatIso(
          DateTime.addDuration(
            DateTime.makeUnsafe(now),
            Duration.seconds(GOAL_CONTINUATION_LEASE_SECONDS),
          ),
        );
        return { now, leaseExpiresAt };
      });

      const enqueueIdle = Effect.fn("GoalContinuationCoordinator.enqueueIdle")(
        function* (request: GoalContinuationRequest) {
          const current = yield* repository.current(request.threadId);
          if (current === null || current.state !== "active") return null;
          const now = yield* clock.nowIso;
          const id = yield* ids.next;
          return yield* repository.enqueueContinuation({
            id,
            threadId: request.threadId,
            goalId: current.id,
            goalRevision: current.revision,
            opportunityKey: request.opportunityKey,
            deliveryMarker: goalContinuationMarker(id),
            now,
          });
        },
      );

      const recover = Effect.fn("GoalContinuationCoordinator.recover")(
        function* () {
          const now = yield* clock.nowIso;
          yield* repository.recoverContinuations(now);
          const sending = yield* repository.sendingContinuations();
          for (const continuation of sending) {
            const deliveryMarker =
              continuation.deliveryMarker ??
              goalContinuationMarker(continuation.id);
            const delivered = yield* gateway.reconcileContinuation(
              continuation.threadId,
              deliveryMarker,
            );
            if (delivered) {
              yield* repository.resolveContinuation({
                id: continuation.id,
                now,
                outcome: "sent",
                reason: "Delivery marker reconciled after restart",
              });
            } else {
              yield* repository.requeueContinuation({
                id: continuation.id,
                deliveryMarker,
                now,
                reason: "Delivery marker absent after restart",
              });
            }
          }
        },
      );

      const process = Effect.fn("GoalContinuationCoordinator.process")(
        function* (signal?: AbortSignal) {
          const lease = yield* nowAndLease;
          const continuation = yield* repository.claimContinuation(lease);
          if (continuation === null) return { kind: "idle" as const };

          const current = yield* repository.current(continuation.threadId);
          const thread = yield* gateway.readThread(
            continuation.threadId,
            signal,
          );
          if (
            signal?.aborted === true ||
            current === null ||
            current.id !== continuation.goalId ||
            current.revision !== continuation.goalRevision ||
            current.state !== "active" ||
            thread.status !== "idle"
          ) {
            yield* repository.resolveContinuation({
              id: continuation.id,
              now: lease.now,
              outcome: "released",
              reason:
                signal?.aborted === true
                  ? "plugin cancellation"
                  : "Goal or thread was no longer eligible",
            });
            return { kind: "released" as const, continuation };
          }

          const deliveryMarker =
            continuation.deliveryMarker ??
            goalContinuationMarker(continuation.id);
          const markedSending = yield* repository.markContinuationSending({
            id: continuation.id,
            deliveryMarker,
            now: lease.now,
            leaseExpiresAt: lease.leaseExpiresAt,
          });
          if (!markedSending) return { kind: "released" as const, continuation };

          try {
            yield* gateway.sendContinuation(
              continuation.threadId,
              deliveryMarker,
              signal,
            );
          } catch (cause) {
            yield* repository.resolveContinuation({
              id: continuation.id,
              now: lease.now,
              outcome: "released",
              reason: cause instanceof Error ? cause.message : String(cause),
            });
            return { kind: "released" as const, continuation };
          }

          yield* repository.resolveContinuation({
            id: continuation.id,
            now: lease.now,
            outcome: "sent",
            reason: "Continuation sent",
          });
          return { kind: "sent" as const, continuation };
        },
      );

      return GoalContinuationCoordinator.of({
        enqueueIdle,
        recover,
        process,
      });
    }),
  );
}
