import type BetterSqlite3 from "better-sqlite3";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import {
  GoalClock,
  GoalContinuationCoordinator,
  GoalCoordinator,
  GoalIdGenerator,
  liveGoalClockLayer,
  liveGoalIdGeneratorLayer,
  makeGoalThreadGatewayLayer,
  type GoalThreadGatewayAdapter,
} from "./coordinator";
import {
  goalErrorToDto,
  type GoalCommand,
  type GoalCommandResult,
  type GoalDto,
  type GoalFailure,
  type GoalFailureEventIdentity,
} from "./domain";
import { makeGoalRepositoryLayer } from "./repository";

export interface GoalRuntime {
  readonly run: (command: GoalCommand) => Promise<GoalCommandResult>;
  readonly enqueueIdle: (
    threadId: string,
    opportunityKey: string,
  ) => Promise<void>;
  readonly recordFailure: (
    threadId: string,
    failure: GoalFailure,
    event?: GoalFailureEventIdentity,
    observedEvents?: readonly GoalFailureEventIdentity[],
  ) => Promise<GoalDto | null>;
  readonly recoverContinuations: () => Promise<void>;
  readonly assessSettledContinuations: (
    signal?: AbortSignal,
  ) => Promise<readonly GoalDto[]>;
  readonly recoverUsageLimits: () => Promise<readonly GoalDto[]>;
  readonly nextUsageLimitReset: () => Promise<string | null>;
  readonly processContinuation: (signal: AbortSignal) => Promise<boolean>;
  readonly dispose: () => Promise<void>;
}

export interface GoalRuntimeOptions {
  readonly nextGoalId?: () => string;
  readonly nowIso?: () => string;
}

export function makeGoalRuntime(
  database: BetterSqlite3.Database,
  gateway: GoalThreadGatewayAdapter,
  options: GoalRuntimeOptions = {},
): GoalRuntime {
  const idLayer =
    options.nextGoalId === undefined
      ? liveGoalIdGeneratorLayer
      : Layer.succeed(
          GoalIdGenerator,
          GoalIdGenerator.of({
            next: Effect.sync(options.nextGoalId),
          }),
        );
  const clockLayer =
    options.nowIso === undefined
      ? liveGoalClockLayer
      : Layer.succeed(
          GoalClock,
          GoalClock.of({
            nowIso: Effect.sync(options.nowIso),
          }),
        );

  const dependencies = Layer.mergeAll(
    makeGoalRepositoryLayer(database),
    makeGoalThreadGatewayLayer(gateway),
    idLayer,
    clockLayer,
  );
  const coordinatorLayer = Layer.mergeAll(
    GoalCoordinator.layer,
    GoalContinuationCoordinator.layer,
  ).pipe(Layer.provide(dependencies));
  const runtime = ManagedRuntime.make(coordinatorLayer);
  let disposed = false;

  return {
    async run(command) {
      const result = await runtime.runPromise(
        GoalCoordinator.use((coordinator) => coordinator.execute(command)).pipe(
          Effect.result,
        ),
      );
      return Result.isFailure(result)
        ? { ok: false, error: goalErrorToDto(result.failure) }
        : { ok: true, ...result.success };
    },
    async enqueueIdle(threadId, opportunityKey) {
      await runtime.runPromise(
        GoalContinuationCoordinator.use((coordinator) =>
          coordinator.enqueueIdle({ threadId, opportunityKey }),
        ),
      );
    },
    async recordFailure(threadId, failure, event, observedEvents) {
      const result = await runtime.runPromise(
        GoalCoordinator.use((coordinator) =>
          coordinator.execute({
            type: "failure",
            threadId,
            failure,
            event,
            observedEvents,
          }),
        ),
      );
      return "goal" in result ? result.goal : null;
    },
    async recoverContinuations() {
      await runtime.runPromise(
        GoalContinuationCoordinator.use((coordinator) => coordinator.recover()),
      );
    },
    async assessSettledContinuations(signal) {
      return runtime.runPromise(
        GoalContinuationCoordinator.use((coordinator) =>
          coordinator.assessSettled(signal),
        ),
      );
    },
    async recoverUsageLimits() {
      return runtime.runPromise(
        GoalContinuationCoordinator.use((coordinator) =>
          coordinator.recoverUsageLimits(),
        ),
      );
    },
    async nextUsageLimitReset() {
      return runtime.runPromise(
        GoalContinuationCoordinator.use((coordinator) =>
          coordinator.nextUsageLimitReset(),
        ),
      );
    },
    async processContinuation(signal) {
      const result = await runtime.runPromise(
        GoalContinuationCoordinator.use((coordinator) =>
          coordinator.process(signal),
        ),
      );
      return result.kind !== "idle";
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await runtime.dispose();
    },
  };
}
