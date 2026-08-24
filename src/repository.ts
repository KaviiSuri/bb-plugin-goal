import type BetterSqlite3 from "better-sqlite3";
import { Context, Effect, Layer, Schema } from "effect";
import {
  GoalAlreadyExists,
  GoalDtoSchema,
  GoalInvalidTransition,
  GoalNotFound,
  GoalPersistenceError,
  GoalStaleGuard,
  type GoalDto,
  type GoalMutationCommand,
  type GoalMutationType,
} from "./domain";

export const GOAL_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    objective TEXT NOT NULL CHECK (length(objective) > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'waiting', 'completed', 'blocked', 'canceled')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS goals_one_unfinished_per_thread
    ON goals(thread_id)
    WHERE finished_at IS NULL`,
] as const;

export function migrateGoalDatabase(database: BetterSqlite3.Database): void {
  const migrate = database.transaction(() => {
    for (const statement of GOAL_MIGRATIONS) {
      database.exec(statement);
    }
  });
  migrate();
}

interface StartGoalRecord {
  readonly id: string;
  readonly threadId: string;
  readonly objective: string;
  readonly now: string;
}

export interface MutateGoalRecord {
  readonly command: GoalMutationCommand;
  readonly now: string;
}

type GoalMutationError =
  | GoalNotFound
  | GoalStaleGuard
  | GoalInvalidTransition
  | GoalPersistenceError;

interface GoalRepositoryService {
  readonly start: (
    record: StartGoalRecord,
  ) => Effect.Effect<GoalDto, GoalAlreadyExists | GoalPersistenceError>;
  readonly current: (
    threadId: string,
  ) => Effect.Effect<GoalDto | null, GoalPersistenceError>;
  readonly mutate: (
    record: MutateGoalRecord,
  ) => Effect.Effect<GoalDto, GoalMutationError>;
}

export class GoalRepository extends Context.Service<
  GoalRepository,
  GoalRepositoryService
>()("bb-plugin-goal/GoalRepository") {}

const decodeGoal = Schema.decodeUnknownSync(GoalDtoSchema);

type GoalRow = {
  readonly id: string;
  readonly threadId: string;
  readonly objective: string;
  readonly state: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
};

function messageFromCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function permitsMutation(goal: GoalDto, action: GoalMutationType): boolean {
  switch (action) {
    case "edit":
    case "cancel":
      return goal.finishedAt === null;
    case "pause":
      return goal.state === "active";
    case "resume":
      return goal.state === "paused";
  }
}

function mutationErrorFromCause(cause: unknown): GoalMutationError {
  if (
    cause instanceof GoalNotFound ||
    cause instanceof GoalStaleGuard ||
    cause instanceof GoalInvalidTransition
  ) {
    return cause;
  }
  return new GoalPersistenceError({
    message: `Could not mutate Goal state: ${messageFromCause(cause)}`,
  });
}

export function makeGoalRepositoryLayer(
  database: BetterSqlite3.Database,
): Layer.Layer<GoalRepository> {
  return Layer.effect(
    GoalRepository,
    Effect.sync(() => {
      const goalColumns = `SELECT
          id,
          thread_id AS threadId,
          objective,
          state,
          revision,
          created_at AS createdAt,
          updated_at AS updatedAt,
          finished_at AS finishedAt
        FROM goals`;
      const selectCurrent = database.prepare<[string], GoalRow>(`${goalColumns}
        WHERE thread_id = ? AND finished_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`);
      const selectById = database.prepare<[string, string], GoalRow>(
        `${goalColumns} WHERE id = ? AND thread_id = ? LIMIT 1`,
      );

      const insert = database.prepare(
        `INSERT INTO goals (
          id, thread_id, objective, state, revision,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)`,
      );
      const edit = database.prepare(
        `UPDATE goals
          SET objective = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND thread_id = ? AND revision = ? AND finished_at IS NULL`,
      );
      const pause = database.prepare(
        `UPDATE goals
          SET state = 'paused', revision = revision + 1, updated_at = ?
          WHERE id = ? AND thread_id = ? AND revision = ? AND state = 'active' AND finished_at IS NULL`,
      );
      const resume = database.prepare(
        `UPDATE goals
          SET state = 'active', revision = revision + 1, updated_at = ?
          WHERE id = ? AND thread_id = ? AND revision = ? AND state = 'paused' AND finished_at IS NULL`,
      );
      const cancel = database.prepare(
        `UPDATE goals
          SET state = 'canceled', revision = revision + 1, updated_at = ?, finished_at = ?
          WHERE id = ? AND thread_id = ? AND revision = ? AND finished_at IS NULL`,
      );

      const readCurrent = (threadId: string): GoalDto | null => {
        const row = selectCurrent.get(threadId);
        return row === undefined ? null : (decodeGoal(row) as GoalDto);
      };
      const readById = (goalId: string, threadId: string): GoalDto | null => {
        const row = selectById.get(goalId, threadId);
        return row === undefined ? null : (decodeGoal(row) as GoalDto);
      };

      const startTransaction = database.transaction(
        (record: StartGoalRecord): GoalDto | { readonly conflict: GoalDto } => {
          const current = readCurrent(record.threadId);
          if (current !== null) return { conflict: current };

          try {
            insert.run(
              record.id,
              record.threadId,
              record.objective,
              record.now,
              record.now,
            );
          } catch (cause) {
            const winner = readCurrent(record.threadId);
            if (winner !== null) return { conflict: winner };
            throw cause;
          }

          const created = readCurrent(record.threadId);
          if (created === null) {
            throw new Error("Goal insert completed without a readable record.");
          }
          return created;
        },
      );

      const mutateTransaction = database.transaction(
        ({ command, now }: MutateGoalRecord): GoalDto => {
          const before = readById(command.goalId, command.threadId);
          if (before === null) {
            throw new GoalNotFound({
              threadId: command.threadId,
              goalId: command.goalId,
            });
          }
          if (before.revision !== command.expectedRevision) {
            throw new GoalStaleGuard({
              goalId: command.goalId,
              expectedRevision: command.expectedRevision,
              actualRevision: before.revision,
            });
          }
          if (!permitsMutation(before, command.type)) {
            throw new GoalInvalidTransition({
              goalId: command.goalId,
              action: command.type,
              state: before.state,
            });
          }

          const result = (() => {
            switch (command.type) {
              case "edit":
                return edit.run(
                  command.objective,
                  now,
                  command.goalId,
                  command.threadId,
                  command.expectedRevision,
                );
              case "pause":
                return pause.run(
                  now,
                  command.goalId,
                  command.threadId,
                  command.expectedRevision,
                );
              case "resume":
                return resume.run(
                  now,
                  command.goalId,
                  command.threadId,
                  command.expectedRevision,
                );
              case "cancel":
                return cancel.run(
                  now,
                  now,
                  command.goalId,
                  command.threadId,
                  command.expectedRevision,
                );
            }
          })();

          if (result.changes !== 1) {
            const current = readById(command.goalId, command.threadId);
            if (current === null) {
              throw new GoalNotFound({
                threadId: command.threadId,
                goalId: command.goalId,
              });
            }
            if (current.revision !== command.expectedRevision) {
              throw new GoalStaleGuard({
                goalId: command.goalId,
                expectedRevision: command.expectedRevision,
                actualRevision: current.revision,
              });
            }
            throw new GoalInvalidTransition({
              goalId: command.goalId,
              action: command.type,
              state: current.state,
            });
          }

          const updated = readById(command.goalId, command.threadId);
          if (updated === null) {
            throw new Error("Goal update completed without a readable record.");
          }
          return updated;
        },
      );

      const current = Effect.fn("GoalRepository.current")((threadId: string) =>
        Effect.try({
          try: () => readCurrent(threadId),
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not read Goal state: ${messageFromCause(cause)}`,
            }),
        }),
      );

      const start = Effect.fn("GoalRepository.start")((record: StartGoalRecord) =>
        Effect.try({
          try: () => startTransaction(record),
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not persist Goal state: ${messageFromCause(cause)}`,
            }),
        }).pipe(
          Effect.flatMap((result) =>
            "conflict" in result
              ? Effect.fail(
                  new GoalAlreadyExists({
                    threadId: record.threadId,
                    goalId: result.conflict.id,
                  }),
                )
              : Effect.succeed(result),
          ),
        ),
      );

      const mutate = Effect.fn("GoalRepository.mutate")(
        (record: MutateGoalRecord) =>
          Effect.try({
            try: () => mutateTransaction(record),
            catch: mutationErrorFromCause,
          }),
      );

      return GoalRepository.of({ current, start, mutate });
    }),
  );
}
