import type BetterSqlite3 from "better-sqlite3";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import {
  GoalClock,
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
} from "./domain";
import { makeGoalRepositoryLayer } from "./repository";

export interface GoalRuntime {
  readonly run: (command: GoalCommand) => Promise<GoalCommandResult>;
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
  const coordinatorLayer = GoalCoordinator.layer.pipe(
    Layer.provide(dependencies),
  );
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
        : { ok: true, goal: result.success };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await runtime.dispose();
    },
  };
}
