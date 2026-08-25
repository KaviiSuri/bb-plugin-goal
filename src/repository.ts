import type BetterSqlite3 from "better-sqlite3";
import { Context, Effect, Layer, Schema } from "effect";
import {
  GoalAlreadyExists,
  GoalDtoSchema,
  GoalInvalidTransition,
  GoalNotFound,
  GoalPersistenceError,
  GoalRecordNotFound,
  GoalStaleGuard,
  type GoalCompletionCommand,
  type GoalDto,
  type GoalGuardedAction,
  type GoalHistoryPage,
  type GoalMutationCommand,
} from "./domain";
import {
  encodeGoalHistoryCursor,
  type GoalHistoryBoundary,
} from "./history-cursor";

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
  `CREATE TABLE IF NOT EXISTS goal_history_order (
      goal_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      UNIQUE(thread_id, sequence)
    );
    INSERT OR IGNORE INTO goal_history_order (goal_id, thread_id, sequence)
      SELECT id, thread_id,
        ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at, rowid)
      FROM goals;
    CREATE TABLE IF NOT EXISTS goal_history_counters (
      thread_id TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1)
    );
    INSERT INTO goal_history_counters (thread_id, last_sequence)
      SELECT thread_id, MAX(sequence)
      FROM goal_history_order
      GROUP BY thread_id
      ON CONFLICT(thread_id) DO UPDATE SET
        last_sequence = MAX(last_sequence, excluded.last_sequence);
    CREATE INDEX IF NOT EXISTS goals_history_by_thread
      ON goal_history_order(thread_id, sequence DESC)`,
  `ALTER TABLE goals ADD COLUMN completion_summary TEXT;
   ALTER TABLE goals ADD COLUMN verification_evidence TEXT`,
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
  readonly command: GoalMutationCommand | GoalCompletionCommand;
  readonly now: string;
}

export interface HistoryGoalRecords {
  readonly threadId: string;
  readonly limit: number;
  readonly boundary: GoalHistoryBoundary | null;
}

export interface DeleteGoalRecord {
  readonly threadId: string;
  readonly goalId: string;
  readonly expectedRevision: number;
}

type GoalMutationError =
  | GoalNotFound
  | GoalStaleGuard
  | GoalInvalidTransition
  | GoalPersistenceError;

type GoalDeleteError = GoalNotFound | GoalStaleGuard | GoalPersistenceError;

interface GoalRepositoryService {
  readonly start: (
    record: StartGoalRecord,
  ) => Effect.Effect<GoalDto, GoalAlreadyExists | GoalPersistenceError>;
  readonly current: (
    threadId: string,
  ) => Effect.Effect<GoalDto | null, GoalPersistenceError>;
  readonly history: (
    record: HistoryGoalRecords,
  ) => Effect.Effect<GoalHistoryPage, GoalPersistenceError>;
  readonly find: (
    goalId: string,
  ) => Effect.Effect<GoalDto, GoalRecordNotFound | GoalPersistenceError>;
  readonly mutate: (
    record: MutateGoalRecord,
  ) => Effect.Effect<GoalDto, GoalMutationError>;
  readonly delete: (
    record: DeleteGoalRecord,
  ) => Effect.Effect<GoalDto, GoalDeleteError>;
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
  readonly completionSummary: string | null;
  readonly verificationEvidence: string | null;
};

type GoalHistoryRow = GoalRow & { readonly historySequence: number };

function messageFromCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function permitsMutation(goal: GoalDto, action: GoalGuardedAction): boolean {
  switch (action) {
    case "edit":
    case "cancel":
      return goal.finishedAt === null;
    case "pause":
    case "complete":
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

function deleteErrorFromCause(cause: unknown): GoalDeleteError {
  if (cause instanceof GoalNotFound || cause instanceof GoalStaleGuard) {
    return cause;
  }
  return new GoalPersistenceError({
    message: `Could not delete Goal: ${messageFromCause(cause)}`,
  });
}

const goalColumns = `SELECT
    id,
    thread_id AS threadId,
    objective,
    state,
    revision,
    created_at AS createdAt,
    updated_at AS updatedAt,
    finished_at AS finishedAt,
    completion_summary AS completionSummary,
    verification_evidence AS verificationEvidence
  FROM goals`;

export interface CurrentGoalSnapshotReader {
  readonly current: (threadId: string) => GoalDto | null;
}

export function makeCurrentGoalSnapshotReader(
  database: BetterSqlite3.Database,
): CurrentGoalSnapshotReader {
  const selectCurrent = database.prepare<[string], GoalRow>(`${goalColumns}
    WHERE thread_id = ? AND finished_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1`);
  return {
    current(threadId) {
      const row = selectCurrent.get(threadId);
      return row === undefined ? null : (decodeGoal(row) as GoalDto);
    },
  };
}

export function makeGoalRepositoryLayer(
  database: BetterSqlite3.Database,
): Layer.Layer<GoalRepository> {
  return Layer.effect(
    GoalRepository,
    Effect.sync(() => {
      const selectCurrent = database.prepare<[string], GoalRow>(`${goalColumns}
        WHERE thread_id = ? AND finished_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`);
      const historyColumns = `SELECT
          goals.id,
          goals.thread_id AS threadId,
          goals.objective,
          goals.state,
          goals.revision,
          goals.created_at AS createdAt,
          goals.updated_at AS updatedAt,
          goals.finished_at AS finishedAt,
          goals.completion_summary AS completionSummary,
          goals.verification_evidence AS verificationEvidence,
          goal_history_order.sequence AS historySequence
        FROM goals
        INNER JOIN goal_history_order
          ON goal_history_order.goal_id = goals.id`;
      const selectByThreadAndId = database.prepare<[string, string], GoalRow>(
        `${goalColumns} WHERE id = ? AND thread_id = ? LIMIT 1`,
      );
      const selectById = database.prepare<[string], GoalRow>(
        `${goalColumns} WHERE id = ? LIMIT 1`,
      );
      const selectHistoryFirst = database.prepare<
        [string, number],
        GoalHistoryRow
      >(`${historyColumns}
          WHERE goal_history_order.thread_id = ?
          ORDER BY goal_history_order.sequence DESC
          LIMIT ?`);
      const selectHistoryAfter = database.prepare<
        [string, number, number],
        GoalHistoryRow
      >(`${historyColumns}
          WHERE goal_history_order.thread_id = ?
            AND goal_history_order.sequence < ?
          ORDER BY goal_history_order.sequence DESC
          LIMIT ?`);

      const nextHistorySequence = database.prepare<
        [string],
        { readonly sequence: number }
      >(`INSERT INTO goal_history_counters (thread_id, last_sequence)
          VALUES (?, 1)
          ON CONFLICT(thread_id) DO UPDATE SET
            last_sequence = last_sequence + 1
          RETURNING last_sequence AS sequence`);
      const insertHistoryOrder = database.prepare(
        `INSERT INTO goal_history_order (goal_id, thread_id, sequence)
          VALUES (?, ?, ?)`,
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
      const complete = database.prepare(
        `UPDATE goals
          SET state = 'completed', revision = revision + 1,
            updated_at = ?, finished_at = ?, completion_summary = ?,
            verification_evidence = ?
          WHERE id = ? AND thread_id = ? AND revision = ?
            AND state = 'active' AND finished_at IS NULL`,
      );
      const deleteByGuard = database.prepare(
        `DELETE FROM goals
          WHERE id = ? AND thread_id = ? AND revision = ?`,
      );
      const deleteHistoryOrder = database.prepare(
        `DELETE FROM goal_history_order WHERE goal_id = ?`,
      );

      const readCurrent = (threadId: string): GoalDto | null => {
        const row = selectCurrent.get(threadId);
        return row === undefined ? null : (decodeGoal(row) as GoalDto);
      };
      const readByThreadAndId = (
        goalId: string,
        threadId: string,
      ): GoalDto | null => {
        const row = selectByThreadAndId.get(goalId, threadId);
        return row === undefined ? null : (decodeGoal(row) as GoalDto);
      };
      const readById = (goalId: string): GoalDto | null => {
        const row = selectById.get(goalId);
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

          const counter = nextHistorySequence.get(record.threadId);
          if (counter === undefined) {
            throw new Error("Goal history sequence was not allocated.");
          }
          insertHistoryOrder.run(record.id, record.threadId, counter.sequence);

          const created = readCurrent(record.threadId);
          if (created === null) {
            throw new Error("Goal insert completed without a readable record.");
          }
          return created;
        },
      );

      const mutateTransaction = database.transaction(
        ({ command, now }: MutateGoalRecord): GoalDto => {
          const before = readByThreadAndId(command.goalId, command.threadId);
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
              case "complete":
                return complete.run(
                  now,
                  now,
                  command.summary,
                  command.verificationEvidence,
                  command.goalId,
                  command.threadId,
                  command.expectedRevision,
                );
            }
          })();

          if (result.changes !== 1) {
            const current = readByThreadAndId(
              command.goalId,
              command.threadId,
            );
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

          const updated = readByThreadAndId(
            command.goalId,
            command.threadId,
          );
          if (updated === null) {
            throw new Error("Goal update completed without a readable record.");
          }
          return updated;
        },
      );

      const deleteTransaction = database.transaction(
        (record: DeleteGoalRecord): GoalDto => {
          const before = readByThreadAndId(record.goalId, record.threadId);
          if (before === null) {
            throw new GoalNotFound({
              threadId: record.threadId,
              goalId: record.goalId,
            });
          }
          if (before.revision !== record.expectedRevision) {
            throw new GoalStaleGuard({
              goalId: record.goalId,
              expectedRevision: record.expectedRevision,
              actualRevision: before.revision,
            });
          }

          const result = deleteByGuard.run(
            record.goalId,
            record.threadId,
            record.expectedRevision,
          );
          if (result.changes !== 1) {
            const current = readByThreadAndId(record.goalId, record.threadId);
            if (current === null) {
              throw new GoalNotFound({
                threadId: record.threadId,
                goalId: record.goalId,
              });
            }
            throw new GoalStaleGuard({
              goalId: record.goalId,
              expectedRevision: record.expectedRevision,
              actualRevision: current.revision,
            });
          }
          deleteHistoryOrder.run(record.goalId);
          return before;
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

      const history = Effect.fn("GoalRepository.history")(
        (record: HistoryGoalRecords) =>
          Effect.try({
            try: (): GoalHistoryPage => {
              const rowLimit = record.limit + 1;
              const rows =
                record.boundary === null
                  ? selectHistoryFirst.all(record.threadId, rowLimit)
                  : selectHistoryAfter.all(
                      record.threadId,
                      record.boundary.sequence,
                      rowLimit,
                    );
              const goals = rows
                .slice(0, record.limit)
                .map((row) => decodeGoal(row) as GoalDto);
              const lastRow = rows.at(record.limit - 1);
              return {
                goals,
                nextCursor:
                  rows.length > record.limit && lastRow !== undefined
                    ? encodeGoalHistoryCursor({
                        threadId: record.threadId,
                        sequence: lastRow.historySequence,
                      })
                    : null,
              };
            },
            catch: (cause) =>
              new GoalPersistenceError({
                message: `Could not read Goal history: ${messageFromCause(cause)}`,
              }),
          }),
      );

      const find = Effect.fn("GoalRepository.find")((goalId: string) =>
        Effect.try({
          try: () => readById(goalId),
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not read Goal: ${messageFromCause(cause)}`,
            }),
        }).pipe(
          Effect.flatMap((goal) =>
            goal === null
              ? Effect.fail(new GoalRecordNotFound({ goalId }))
              : Effect.succeed(goal),
          ),
        ),
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

      const deleteGoal = Effect.fn("GoalRepository.delete")(
        (record: DeleteGoalRecord) =>
          Effect.try({
            try: () => deleteTransaction(record),
            catch: deleteErrorFromCause,
          }),
      );

      return GoalRepository.of({
        current,
        history,
        find,
        start,
        mutate,
        delete: deleteGoal,
      });
    }),
  );
}
