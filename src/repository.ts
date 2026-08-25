import type BetterSqlite3 from "better-sqlite3";
import { Context, Effect, Layer, Schema } from "effect";
import {
  GoalAlreadyExists,
  GoalDtoSchema,
  GoalInvalidBlockage,
  GoalInvalidTransition,
  GoalNotFound,
  GoalPersistenceError,
  GoalRecordNotFound,
  GoalStaleGuard,
  type GoalBlockedCommand,
  type GoalCompletionCommand,
  type GoalDto,
  type GoalFailure,
  type GoalFailureEventIdentity,
  type GoalGuardedAction,
  type GoalHistoryPage,
  type GoalMutationCommand,
  type GoalNoProgressEvidence,
  type GoalProgressSignalKind,
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
  `ALTER TABLE goals ADD COLUMN blockage_external_action TEXT;
   ALTER TABLE goals ADD COLUMN blockage_evidence TEXT;
   ALTER TABLE goals ADD COLUMN blockage_repeated_turns INTEGER`,
  `CREATE TABLE IF NOT EXISTS goal_blockage_qualifications (
    goal_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    goal_revision INTEGER NOT NULL CHECK (goal_revision >= 1),
    blocker_key TEXT NOT NULL,
    external_action TEXT NOT NULL,
    evidence TEXT NOT NULL,
    repeated_turns INTEGER NOT NULL CHECK (repeated_turns >= 1),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS goal_continuations (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    goal_revision INTEGER NOT NULL CHECK (goal_revision >= 1),
    opportunity_key TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'sending', 'resolved')),
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sent', 'released', 'expired')),
    lease_expires_at TEXT,
    outcome_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(thread_id, opportunity_key)
  );
  CREATE INDEX IF NOT EXISTS goal_continuations_pending
    ON goal_continuations(state, lease_expires_at, created_at)`,
  `ALTER TABLE goal_continuations ADD COLUMN delivery_marker TEXT`,
  `ALTER TABLE goals ADD COLUMN pause_reason_code TEXT;
   ALTER TABLE goals ADD COLUMN pause_reason TEXT;
   ALTER TABLE goals ADD COLUMN usage_limit_kind TEXT;
   ALTER TABLE goals ADD COLUMN usage_reset_at TEXT`,
  `CREATE TABLE IF NOT EXISTS goal_failure_events (
    thread_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_seq INTEGER CHECK (event_seq IS NULL OR event_seq >= 0),
    event_created_at INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS goal_failure_events_by_sequence
    ON goal_failure_events(thread_id, event_seq DESC)`,
  `ALTER TABLE goal_failure_events ADD COLUMN turn_id TEXT`,
  `ALTER TABLE goals ADD COLUMN no_progress_consecutive_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE goals ADD COLUMN no_progress_last_continuation_id TEXT;
   ALTER TABLE goals ADD COLUMN no_progress_assistant_result_fingerprint TEXT;
   ALTER TABLE goals ADD COLUMN no_progress_evidence_json TEXT;
   ALTER TABLE goal_continuations ADD COLUMN progress_assessed_at TEXT;
   ALTER TABLE goal_continuations ADD COLUMN progress_evidence_json TEXT;
   CREATE INDEX IF NOT EXISTS goal_continuations_unassessed_sent
     ON goal_continuations(outcome, progress_assessed_at, created_at)`,
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
  readonly command:
    | GoalMutationCommand
    | GoalCompletionCommand
    | GoalBlockedCommand;
  readonly now: string;
}

export interface RecordGoalFailure {
  readonly threadId: string;
  readonly failure: GoalFailure;
  readonly now: string;
  readonly event?: GoalFailureEventIdentity;
  readonly observedEvents?: readonly GoalFailureEventIdentity[];
}

export interface RecoverGoalUsageLimitRecord {
  readonly goalId: string;
  readonly threadId: string;
  readonly expectedRevision: number;
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
  | GoalInvalidBlockage
  | GoalPersistenceError;

type GoalDeleteError = GoalNotFound | GoalStaleGuard | GoalPersistenceError;

export type GoalContinuationState =
  | "pending"
  | "claimed"
  | "sending"
  | "resolved";
export type GoalContinuationOutcome = "sent" | "released" | "expired";

export interface GoalContinuationRecord {
  readonly id: string;
  readonly threadId: string;
  readonly goalId: string;
  readonly goalRevision: number;
  readonly opportunityKey: string;
  readonly deliveryMarker: string | null;
  readonly attempt: number;
  readonly state: GoalContinuationState;
  readonly outcome: GoalContinuationOutcome | null;
  readonly leaseExpiresAt: string | null;
  readonly outcomeReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progressAssessedAt: string | null;
}

export interface EnqueueGoalContinuationRecord {
  readonly id: string;
  readonly threadId: string;
  readonly goalId: string;
  readonly goalRevision: number;
  readonly opportunityKey: string;
  readonly deliveryMarker: string;
  readonly now: string;
}

export interface ClaimGoalContinuationRecord {
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface MarkGoalContinuationSendingRecord {
  readonly id: string;
  readonly deliveryMarker: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface RequeueGoalContinuationRecord {
  readonly id: string;
  readonly deliveryMarker: string;
  readonly now: string;
  readonly reason: string;
}

export interface ResolveGoalContinuationRecord {
  readonly id: string;
  readonly now: string;
  readonly outcome: GoalContinuationOutcome;
  readonly reason: string;
}

export interface AssessGoalContinuationRecord {
  readonly continuationId: string;
  readonly goalId: string;
  readonly goalRevision: number;
  readonly threadId: string;
  readonly observation: Omit<
    GoalNoProgressEvidence,
    | "continuationId"
    | "signals"
    | "previousAssistantResultFingerprint"
    | "assessment"
    | "observedAt"
  > & {
    readonly signals: readonly Exclude<
      GoalProgressSignalKind,
      "changed-assistant-result"
    >[];
  };
  readonly now: string;
}

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
  readonly recordFailure: (
    record: RecordGoalFailure,
  ) => Effect.Effect<GoalDto | null, GoalPersistenceError>;
  readonly dueUsageLimits: (
    now: string,
  ) => Effect.Effect<readonly GoalDto[], GoalPersistenceError>;
  readonly recoverUsageLimit: (
    record: RecoverGoalUsageLimitRecord,
  ) => Effect.Effect<GoalDto | null, GoalPersistenceError>;
  readonly nextUsageLimitReset: () => Effect.Effect<string | null, GoalPersistenceError>;
  readonly delete: (
    record: DeleteGoalRecord,
  ) => Effect.Effect<GoalDto, GoalDeleteError>;
  readonly enqueueContinuation: (
    record: EnqueueGoalContinuationRecord,
  ) => Effect.Effect<GoalContinuationRecord | null, GoalPersistenceError>;
  readonly recoverContinuations: (
    now: string,
  ) => Effect.Effect<void, GoalPersistenceError>;
  readonly sendingContinuations: () => Effect.Effect<
    readonly GoalContinuationRecord[],
    GoalPersistenceError
  >;
  readonly requeueContinuation: (
    record: RequeueGoalContinuationRecord,
  ) => Effect.Effect<boolean, GoalPersistenceError>;
  readonly claimContinuation: (
    record: ClaimGoalContinuationRecord,
  ) => Effect.Effect<GoalContinuationRecord | null, GoalPersistenceError>;
  readonly markContinuationSending: (
    record: MarkGoalContinuationSendingRecord,
  ) => Effect.Effect<boolean, GoalPersistenceError>;
  readonly resolveContinuation: (
    record: ResolveGoalContinuationRecord,
  ) => Effect.Effect<boolean, GoalPersistenceError>;
  readonly unassessedSentContinuations: () => Effect.Effect<
    readonly GoalContinuationRecord[],
    GoalPersistenceError
  >;
  readonly assessContinuation: (
    record: AssessGoalContinuationRecord,
  ) => Effect.Effect<GoalDto | null, GoalPersistenceError>;
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
  readonly blockageExternalAction: string | null;
  readonly blockageEvidence: string | null;
  readonly blockageRepeatedTurns: number | null;
  readonly pauseReasonCode: string | null;
  readonly pauseReason: string | null;
  readonly usageLimitKind: string | null;
  readonly usageResetAt: string | null;
  readonly noProgressConsecutiveCount: number;
  readonly noProgressLastContinuationId: string | null;
  readonly noProgressAssistantResultFingerprint: string | null;
  readonly noProgressEvidence: string | null;
};

type GoalHistoryRow = GoalRow & { readonly historySequence: number };

type GoalBlockageQualificationRow = {
  readonly goalRevision: number;
  readonly blockerKey: string;
  readonly repeatedTurns: number;
};

type GoalContinuationRow = {
  readonly id: string;
  readonly threadId: string;
  readonly goalId: string;
  readonly goalRevision: number;
  readonly opportunityKey: string;
  readonly deliveryMarker: string | null;
  readonly attempt: number;
  readonly state: GoalContinuationState;
  readonly outcome: GoalContinuationOutcome | null;
  readonly leaseExpiresAt: string | null;
  readonly outcomeReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progressAssessedAt: string | null;
};

function decodeContinuation(row: GoalContinuationRow): GoalContinuationRecord {
  return row;
}

function decodeGoalRow(row: GoalRow): GoalDto {
  return decodeGoal({
    ...row,
    noProgressEvidence:
      row.noProgressEvidence === null
        ? null
        : JSON.parse(row.noProgressEvidence),
  }) as GoalDto;
}

function messageFromCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function normalizeBlocker(externalAction: string): string {
  return externalAction.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function permitsMutation(goal: GoalDto, action: GoalGuardedAction): boolean {
  switch (action) {
    case "edit":
    case "cancel":
      return goal.finishedAt === null;
    case "complete":
    case "block":
      return goal.state === "active";
    case "pause":
      return goal.state === "active" || goal.state === "waiting";
    case "resume":
      return goal.state === "paused" || goal.state === "waiting";
  }
}

function mutationErrorFromCause(cause: unknown): GoalMutationError {
  if (
    cause instanceof GoalNotFound ||
    cause instanceof GoalStaleGuard ||
    cause instanceof GoalInvalidTransition ||
    cause instanceof GoalInvalidBlockage
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
    verification_evidence AS verificationEvidence,
    blockage_external_action AS blockageExternalAction,
    blockage_evidence AS blockageEvidence,
    blockage_repeated_turns AS blockageRepeatedTurns,
    pause_reason_code AS pauseReasonCode,
    pause_reason AS pauseReason,
    usage_limit_kind AS usageLimitKind,
    usage_reset_at AS usageResetAt,
    no_progress_consecutive_count AS noProgressConsecutiveCount,
    no_progress_last_continuation_id AS noProgressLastContinuationId,
    no_progress_assistant_result_fingerprint AS noProgressAssistantResultFingerprint,
    no_progress_evidence_json AS noProgressEvidence
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
      return row === undefined ? null : decodeGoalRow(row);
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
          goals.blockage_external_action AS blockageExternalAction,
          goals.blockage_evidence AS blockageEvidence,
          goals.blockage_repeated_turns AS blockageRepeatedTurns,
          goals.pause_reason_code AS pauseReasonCode,
          goals.pause_reason AS pauseReason,
          goals.usage_limit_kind AS usageLimitKind,
          goals.usage_reset_at AS usageResetAt,
          goals.no_progress_consecutive_count AS noProgressConsecutiveCount,
          goals.no_progress_last_continuation_id AS noProgressLastContinuationId,
          goals.no_progress_assistant_result_fingerprint AS noProgressAssistantResultFingerprint,
          goals.no_progress_evidence_json AS noProgressEvidence,
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
          SET objective = ?, revision = revision + 1, updated_at = ?,
            no_progress_consecutive_count = 0,
            no_progress_last_continuation_id = NULL,
            no_progress_assistant_result_fingerprint = NULL,
            no_progress_evidence_json = NULL
          WHERE id = ? AND thread_id = ? AND revision = ? AND finished_at IS NULL`,
      );
      const pause = database.prepare(
        `UPDATE goals
          SET state = 'paused', revision = revision + 1, updated_at = ?,
            pause_reason_code = 'manual', pause_reason = 'Paused by user',
            usage_limit_kind = NULL, usage_reset_at = NULL
          WHERE id = ? AND thread_id = ? AND revision = ?
            AND state IN ('active', 'waiting') AND finished_at IS NULL`,
      );
      const resume = database.prepare(
        `UPDATE goals
          SET state = 'active', revision = revision + 1, updated_at = ?,
            pause_reason_code = NULL, pause_reason = NULL,
            usage_limit_kind = NULL, usage_reset_at = NULL,
            no_progress_consecutive_count = 0,
            no_progress_last_continuation_id = NULL,
            no_progress_assistant_result_fingerprint = NULL,
            no_progress_evidence_json = NULL
          WHERE id = ? AND thread_id = ? AND revision = ? AND state IN ('paused', 'waiting') AND finished_at IS NULL`,
      );
      const recordFailure = database.prepare(
        `UPDATE goals
          SET state = ?, revision = revision + 1, updated_at = ?,
            pause_reason_code = ?, pause_reason = ?, usage_limit_kind = ?,
            usage_reset_at = ?
          WHERE id = ? AND thread_id = ?
            AND (
              state = 'active' OR
              (state IN ('paused', 'waiting')
                AND pause_reason_code IN ('failure', 'usage-limit'))
            )
            AND finished_at IS NULL`,
      );
      const insertFailureEvent = database.prepare(
        `INSERT OR IGNORE INTO goal_failure_events (
          thread_id, event_id, event_seq, event_created_at, turn_id, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const selectMaxFailureEventSeq = database.prepare<
        [string],
        { readonly eventSeq: number | null }
      >(
        `SELECT MAX(event_seq) AS eventSeq FROM goal_failure_events
          WHERE thread_id = ?`,
      );
      const selectFailureEventForTurn = database.prepare<
        [string, string],
        { readonly eventId: string }
      >(
        `SELECT event_id AS eventId FROM goal_failure_events
          WHERE thread_id = ? AND turn_id = ?
          LIMIT 1`,
      );
      const recoverUsageLimit = database.prepare(
        `UPDATE goals
          SET state = 'active', revision = revision + 1, updated_at = ?,
            pause_reason_code = NULL, pause_reason = NULL,
            usage_limit_kind = NULL, usage_reset_at = NULL
          WHERE id = ? AND thread_id = ? AND revision = ? AND state = 'waiting'
            AND pause_reason_code = 'usage-limit'
            AND usage_reset_at IS NOT NULL AND usage_reset_at <= ?
            AND finished_at IS NULL`,
      );
      const selectDueUsageLimits = database.prepare<[string], GoalRow>(
        `${goalColumns} WHERE state = 'waiting'
          AND pause_reason_code = 'usage-limit'
          AND usage_reset_at IS NOT NULL AND usage_reset_at <= ?
          AND finished_at IS NULL
          ORDER BY usage_reset_at, id`,
      );
      const selectNextUsageLimitReset = database.prepare<[], { readonly usageResetAt: string }>(
        `SELECT MIN(usage_reset_at) AS usageResetAt FROM goals
          WHERE state = 'waiting' AND pause_reason_code = 'usage-limit'
            AND usage_reset_at IS NOT NULL AND finished_at IS NULL`,
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
      const block = database.prepare(
        `UPDATE goals
          SET state = 'blocked', revision = revision + 1,
            updated_at = ?, finished_at = ?, blockage_external_action = ?,
            blockage_evidence = ?, blockage_repeated_turns = ?
          WHERE id = ? AND thread_id = ? AND revision = ?
            AND state = 'active' AND finished_at IS NULL`,
      );
      const selectBlockageQualification = database.prepare<
        [string, string],
        GoalBlockageQualificationRow
      >(`SELECT goal_revision AS goalRevision,
            blocker_key AS blockerKey, repeated_turns AS repeatedTurns
          FROM goal_blockage_qualifications
          WHERE goal_id = ? AND thread_id = ?`);
      const saveBlockageQualification = database.prepare(
        `INSERT INTO goal_blockage_qualifications (
          goal_id, thread_id, goal_revision, blocker_key, external_action,
          evidence, repeated_turns, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(goal_id) DO UPDATE SET
          goal_revision = excluded.goal_revision,
          blocker_key = excluded.blocker_key,
          external_action = excluded.external_action,
          evidence = excluded.evidence,
          repeated_turns = excluded.repeated_turns,
          updated_at = excluded.updated_at`,
      );
      const deleteBlockageQualification = database.prepare(
        `DELETE FROM goal_blockage_qualifications WHERE goal_id = ?`,
      );
      const deleteByGuard = database.prepare(
        `DELETE FROM goals
          WHERE id = ? AND thread_id = ? AND revision = ?`,
      );
      const deleteHistoryOrder = database.prepare(
        `DELETE FROM goal_history_order WHERE goal_id = ?`,
      );
      const continuationColumns = `SELECT
          id,
          thread_id AS threadId,
          goal_id AS goalId,
          goal_revision AS goalRevision,
          opportunity_key AS opportunityKey,
          delivery_marker AS deliveryMarker,
          attempt,
          state,
          outcome,
          lease_expires_at AS leaseExpiresAt,
          outcome_reason AS outcomeReason,
          created_at AS createdAt,
          updated_at AS updatedAt,
          progress_assessed_at AS progressAssessedAt
        FROM goal_continuations`;
      const insertContinuation = database.prepare(`
        INSERT INTO goal_continuations (
          id, thread_id, goal_id, goal_revision, opportunity_key,
          delivery_marker, attempt, state, outcome, lease_expires_at,
          outcome_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', NULL, NULL, NULL, ?, ?)
        ON CONFLICT DO NOTHING
      `);
      const selectContinuationById = database.prepare<[string], GoalContinuationRow>(
        `${continuationColumns} WHERE id = ?`,
      );
      const selectPendingContinuation = database.prepare<[], GoalContinuationRow>(
        `${continuationColumns}
          WHERE state = 'pending'
          ORDER BY created_at, id
          LIMIT 1`,
      );
      const expireClaimedContinuations = database.prepare<[string, string]>(`
        UPDATE goal_continuations
        SET state = 'pending', outcome = 'expired', lease_expires_at = NULL,
            outcome_reason = 'claim lease expired', updated_at = ?
        WHERE state = 'claimed' AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
      `);
      const selectSendingContinuations = database.prepare<[], GoalContinuationRow>(`
        ${continuationColumns}
          WHERE state = 'sending'
          ORDER BY updated_at, id
      `);
      const selectUnassessedSentContinuations = database.prepare<[], GoalContinuationRow>(`
        ${continuationColumns}
          WHERE state = 'resolved' AND outcome = 'sent'
            AND progress_assessed_at IS NULL
          ORDER BY created_at, id
      `);
      const recoverClaimedContinuations = database.prepare<[string]>(`
        UPDATE goal_continuations
        SET state = 'pending', outcome = 'expired', lease_expires_at = NULL,
            outcome_reason = 'claim recovered after restart', updated_at = ?
        WHERE state = 'claimed'
      `);
      const claimContinuation = database.prepare<[string, string, string]>(`
        UPDATE goal_continuations
        SET state = 'claimed', attempt = attempt + 1,
            lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state = 'pending'
      `);
      const markContinuationSending = database.prepare<[string, string, string, string]>(`
        UPDATE goal_continuations
        SET state = 'sending', delivery_marker = ?, lease_expires_at = ?,
            updated_at = ?
        WHERE id = ? AND state = 'claimed'
      `);
      const requeueContinuation = database.prepare<[string, string, string, string]>(`
        UPDATE goal_continuations
        SET state = 'pending', delivery_marker = ?, outcome = 'expired',
            lease_expires_at = NULL, outcome_reason = ?, updated_at = ?
        WHERE id = ? AND state = 'sending'
      `);
      const resolveContinuation = database.prepare<[string, string, string, string]>(`
        UPDATE goal_continuations
        SET state = 'resolved', outcome = ?, lease_expires_at = NULL,
            outcome_reason = ?, updated_at = ?
        WHERE id = ? AND state IN ('claimed', 'sending')
      `);
      const markContinuationAssessed = database.prepare<
        [string, string, string, string]
      >(`UPDATE goal_continuations
          SET progress_assessed_at = ?, progress_evidence_json = ?, updated_at = ?
          WHERE id = ? AND state = 'resolved' AND outcome = 'sent'
            AND progress_assessed_at IS NULL`);
      const resetNoProgress = database.prepare(
        `UPDATE goals
          SET no_progress_consecutive_count = 0,
            no_progress_last_continuation_id = ?,
            no_progress_assistant_result_fingerprint = ?,
            no_progress_evidence_json = ?, updated_at = ?
          WHERE id = ? AND thread_id = ? AND revision = ?
            AND state = 'active' AND finished_at IS NULL`,
      );
      const incrementNoProgress = database.prepare(
        `UPDATE goals
          SET no_progress_consecutive_count = no_progress_consecutive_count + 1,
            no_progress_last_continuation_id = ?,
            no_progress_assistant_result_fingerprint = ?,
            no_progress_evidence_json = ?, updated_at = ?,
            state = CASE WHEN no_progress_consecutive_count + 1 >= 3 THEN 'paused' ELSE state END,
            revision = CASE WHEN no_progress_consecutive_count + 1 >= 3 THEN revision + 1 ELSE revision END,
            pause_reason_code = CASE WHEN no_progress_consecutive_count + 1 >= 3 THEN 'no-progress' ELSE pause_reason_code END,
            pause_reason = CASE WHEN no_progress_consecutive_count + 1 >= 3 THEN 'Paused after 3 consecutive automatic Continuations made no observable progress' ELSE pause_reason END
          WHERE id = ? AND thread_id = ? AND revision = ?
            AND state = 'active' AND finished_at IS NULL`,
      );
      const releasePendingGoalContinuations = database.prepare(
        `UPDATE goal_continuations
          SET state = 'resolved', outcome = 'released', lease_expires_at = NULL,
            outcome_reason = 'Goal paused by no-progress protection', updated_at = ?
          WHERE goal_id = ? AND goal_revision = ?
            AND state IN ('pending', 'claimed', 'sending')`,
      );

      const readCurrent = (threadId: string): GoalDto | null => {
        const row = selectCurrent.get(threadId);
        return row === undefined ? null : decodeGoalRow(row);
      };
      const readByThreadAndId = (
        goalId: string,
        threadId: string,
      ): GoalDto | null => {
        const row = selectByThreadAndId.get(goalId, threadId);
        return row === undefined ? null : decodeGoalRow(row);
      };
      const readById = (goalId: string): GoalDto | null => {
        const row = selectById.get(goalId);
        return row === undefined ? null : decodeGoalRow(row);
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

          if (command.type === "block") {
            const qualification = selectBlockageQualification.get(
              command.goalId,
              command.threadId,
            );
            const qualificationForRevision =
              qualification === undefined ||
              qualification.goalRevision !== command.expectedRevision
                ? undefined
                : qualification;
            const expectedTurns =
              qualificationForRevision === undefined
                ? 1
                : qualificationForRevision.repeatedTurns + 1;
            const blockerKey = normalizeBlocker(command.externalAction);
            if (
              qualificationForRevision !== undefined &&
              qualificationForRevision.blockerKey !== blockerKey
            ) {
              throw new GoalInvalidBlockage({
                message:
                  "Goal Blockage requires the same external blocker across consecutive reports.",
              });
            }
            if (command.repeatedTurns !== expectedTurns) {
              throw new GoalInvalidBlockage({
                message: `Goal Blockage report ${command.repeatedTurns} is out of sequence; expected report ${expectedTurns}.`,
              });
            }
            saveBlockageQualification.run(
              command.goalId,
              command.threadId,
              command.expectedRevision,
              blockerKey,
              command.externalAction,
              command.evidence,
              command.repeatedTurns,
              now,
            );
            if (command.repeatedTurns < 3) return before;
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
              case "block":
                return block.run(
                  now,
                  now,
                  command.externalAction,
                  command.evidence,
                  command.repeatedTurns,
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

          if (command.type !== "block") {
            deleteBlockageQualification.run(command.goalId);
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

      const recordFailureTransaction = database.transaction(
        (record: RecordGoalFailure): GoalDto | null => {
          const previousMaxEventSeq =
            record.event === undefined
              ? null
              : selectMaxFailureEventSeq.get(record.threadId)?.eventSeq ?? null;
          const observedEvents = [
            ...(record.observedEvents ?? []),
            ...(record.event === undefined ? [] : [record.event]),
          ];
          const priorTurnEvent =
            record.event?.turnId === undefined || record.event.turnId === null
              ? undefined
              : selectFailureEventForTurn.get(
                  record.threadId,
                  record.event.turnId,
                );
          let selectedEventWasNew =
            record.event === undefined && priorTurnEvent === undefined;
          const observedEventIds = new Set<string>();
          for (const event of observedEvents) {
            if (observedEventIds.has(event.id)) continue;
            observedEventIds.add(event.id);
            const inserted = insertFailureEvent.run(
              record.threadId,
              event.id,
              event.seq,
              event.createdAt,
              event.turnId ?? null,
              record.now,
            );
            if (record.event?.id === event.id) {
              selectedEventWasNew =
                inserted.changes === 1 && priorTurnEvent === undefined;
            }
          }

          const current = readCurrent(record.threadId);
          if (current === null) return current;
          if (record.event !== undefined && !selectedEventWasNew) return current;
          if (
            record.event !== undefined &&
            record.event.seq !== null &&
            previousMaxEventSeq !== null &&
            record.event.seq <= previousMaxEventSeq
          ) {
            return current;
          }
          if (
            record.event !== undefined &&
            record.event.createdAt < Date.parse(current.createdAt)
          ) {
            return current;
          }
          if (
            current.state !== "active" &&
            (current.pauseReasonCode === "manual" || record.event === undefined)
          ) {
            return current;
          }
          const usageWait =
            record.failure.kind === "usage-limit" &&
            record.failure.limitKind === "subscription-window" &&
            record.failure.resetAt !== null &&
            record.failure.resetAt > record.now;
          const result = recordFailure.run(
            usageWait ? "waiting" : "paused",
            record.now,
            "usage-limit" === record.failure.kind
              ? "usage-limit"
              : "failure",
            record.failure.reason,
            record.failure.kind === "usage-limit"
              ? record.failure.limitKind
              : null,
            usageWait ? record.failure.resetAt : null,
            current.id,
            record.threadId,
          );
          if (result.changes !== 1) return readCurrent(record.threadId);
          return readCurrent(record.threadId);
        },
      );

      const assessContinuationTransaction = database.transaction(
        (record: AssessGoalContinuationRecord): GoalDto | null => {
          const continuation = selectContinuationById.get(
            record.continuationId,
          );
          if (
            continuation === undefined ||
            continuation.progressAssessedAt !== null ||
            continuation.outcome !== "sent" ||
            continuation.goalId !== record.goalId ||
            continuation.goalRevision !== record.goalRevision ||
            continuation.threadId !== record.threadId
          ) {
            return readCurrent(record.threadId);
          }

          const current = readCurrent(record.threadId);
          const currentEvidence = current?.noProgressEvidence ?? null;
          const ownsCurrentRevision =
            current !== null &&
            current.id === record.goalId &&
            current.revision === record.goalRevision &&
            current.state === "active";
          if (
            !ownsCurrentRevision ||
            (currentEvidence !== null &&
              record.observation.terminalSeq <= currentEvidence.terminalSeq)
          ) {
            const ignored = JSON.stringify({
              assessment: "ignored",
              continuationId: record.continuationId,
              terminalEventId: record.observation.terminalEventId,
              terminalSeq: record.observation.terminalSeq,
              observedAt: record.now,
              reason: !ownsCurrentRevision
                ? "Goal identity, revision, or state changed"
                : "A later Continuation was already assessed",
            });
            markContinuationAssessed.run(
              record.now,
              ignored,
              record.now,
              record.continuationId,
            );
            return current;
          }

          const previousAssistantResultFingerprint =
            current.noProgressAssistantResultFingerprint;
          const changedAssistantResult =
            record.observation.assistantResultFingerprint !== null &&
            record.observation.assistantResultFingerprint !==
              previousAssistantResultFingerprint;
          const signals: GoalProgressSignalKind[] = [
            ...record.observation.signals,
            ...(changedAssistantResult
              ? (["changed-assistant-result"] as const)
              : []),
          ];
          const evidence: GoalNoProgressEvidence = {
            continuationId: record.continuationId,
            ...record.observation,
            signals,
            previousAssistantResultFingerprint,
            assessment: signals.length > 0 ? "progress" : "no-progress",
            observedAt: record.now,
          };
          const evidenceJson = JSON.stringify(evidence);
          const nextAssistantResultFingerprint =
            record.observation.assistantResultFingerprint ??
            previousAssistantResultFingerprint;
          const result =
            signals.length > 0
              ? resetNoProgress.run(
                  record.continuationId,
                  nextAssistantResultFingerprint,
                  evidenceJson,
                  record.now,
                  record.goalId,
                  record.threadId,
                  record.goalRevision,
                )
              : incrementNoProgress.run(
                  record.continuationId,
                  nextAssistantResultFingerprint,
                  evidenceJson,
                  record.now,
                  record.goalId,
                  record.threadId,
                  record.goalRevision,
                );
          if (result.changes !== 1) {
            throw new Error("Goal changed while assessing Continuation progress.");
          }
          const updated = readById(record.goalId);
          if (
            updated !== null &&
            updated.pauseReasonCode === "no-progress" &&
            updated.noProgressConsecutiveCount === 3
          ) {
            releasePendingGoalContinuations.run(
              record.now,
              record.goalId,
              record.goalRevision,
            );
          }
          if (
            markContinuationAssessed.run(
              record.now,
              evidenceJson,
              record.now,
              record.continuationId,
            ).changes !== 1
          ) {
            throw new Error("Continuation assessment was not recorded.");
          }
          return updated;
        },
      );

      const recoverUsageLimitTransaction = database.transaction(
        (record: RecoverGoalUsageLimitRecord): GoalDto | null => {
          const result = recoverUsageLimit.run(
            record.now,
            record.goalId,
            record.threadId,
            record.expectedRevision,
            record.now,
          );
          return result.changes === 1 ? readById(record.goalId) : null;
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
          deleteBlockageQualification.run(record.goalId);
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
                .map(decodeGoalRow);
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

      const recordFailureEffect = Effect.fn("GoalRepository.recordFailure")(
        (record: RecordGoalFailure) =>
          Effect.try({
            try: () => recordFailureTransaction(record),
            catch: (cause) =>
              new GoalPersistenceError({
                message: `Could not persist Goal failure: ${messageFromCause(cause)}`,
              }),
          }),
      );

      const dueUsageLimits = Effect.fn("GoalRepository.dueUsageLimits")(
        (now: string) =>
          Effect.try({
            try: () => selectDueUsageLimits.all(now).map(decodeGoalRow),
            catch: (cause) =>
              new GoalPersistenceError({
                message: `Could not read due Goal usage limits: ${messageFromCause(cause)}`,
              }),
          }),
      );

      const recoverUsageLimitEffect = Effect.fn(
        "GoalRepository.recoverUsageLimit",
      )((record: RecoverGoalUsageLimitRecord) =>
        Effect.try({
          try: () => recoverUsageLimitTransaction(record),
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not recover Goal usage limit: ${messageFromCause(cause)}`,
            }),
        }),
      );

      const nextUsageLimitReset = Effect.fn(
        "GoalRepository.nextUsageLimitReset",
      )(() =>
        Effect.try({
          try: () => selectNextUsageLimitReset.get()?.usageResetAt ?? null,
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not read Goal usage resets: ${messageFromCause(cause)}`,
            }),
        }),
      );

      const enqueueContinuation = Effect.fn("GoalRepository.enqueueContinuation")(
        (record: EnqueueGoalContinuationRecord) =>
          Effect.try({
            try: () => {
              const insertResult = insertContinuation.run(
                record.id,
                record.threadId,
                record.goalId,
                record.goalRevision,
                record.opportunityKey,
                record.deliveryMarker,
                record.now,
                record.now,
              );
              const row = selectContinuationById.get(record.id);
              if (row !== undefined) return decodeContinuation(row);
              if (insertResult.changes === 0) {
                const existing = database
                  .prepare<[string, string], GoalContinuationRow>(
                    `${continuationColumns}
                      WHERE thread_id = ? AND opportunity_key = ?`,
                  )
                  .get(record.threadId, record.opportunityKey);
                return existing === undefined ? null : decodeContinuation(existing);
              }
              throw new Error("Continuation insert completed without a readable record.");
            },
            catch: (cause) =>
              new GoalPersistenceError({
                message: `Could not persist Continuation claim: ${messageFromCause(cause)}`,
              }),
          }),
      );

      const recoverContinuations = Effect.fn("GoalRepository.recoverContinuations")(
        (now: string) =>
          Effect.try({
            try: () => {
              const recover = database.transaction(() => {
                recoverClaimedContinuations.run(now);
              });
              recover();
            },
            catch: (cause) =>
              new GoalPersistenceError({
                message: `Could not recover Continuations: ${messageFromCause(cause)}`,
              }),
          }),
      );

      const sendingContinuations = Effect.fn(
        "GoalRepository.sendingContinuations",
      )(() =>
        Effect.try({
          try: () =>
            selectSendingContinuations.all().map(decodeContinuation),
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not list sending Continuations: ${messageFromCause(cause)}`,
            }),
        }),
      );

      const unassessedSentContinuations = Effect.fn(
        "GoalRepository.unassessedSentContinuations",
      )(() =>
        Effect.try({
          try: () =>
            selectUnassessedSentContinuations.all().map(decodeContinuation),
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not list unassessed Continuations: ${messageFromCause(cause)}`,
            }),
        }),
      );

      const assessContinuation = Effect.fn(
        "GoalRepository.assessContinuation",
      )((record: AssessGoalContinuationRecord) =>
        Effect.try({
          try: () => assessContinuationTransaction(record),
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not assess Continuation progress: ${messageFromCause(cause)}`,
            }),
        }),
      );

      const requeueContinuationClaim = Effect.fn(
        "GoalRepository.requeueContinuation",
      )((record: RequeueGoalContinuationRecord) =>
        Effect.try({
          try: () =>
            requeueContinuation.run(
              record.deliveryMarker,
              record.reason,
              record.now,
              record.id,
            ).changes === 1,
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not requeue Continuation: ${messageFromCause(cause)}`,
            }),
        }),
      );

      const claimNextContinuation = Effect.fn("GoalRepository.claimContinuation")(
        (record: ClaimGoalContinuationRecord) =>
          Effect.try({
            try: () => {
              const transaction = database.transaction(() => {
                expireClaimedContinuations.run(record.now, record.now);
                const pending = selectPendingContinuation.get();
                if (pending === undefined) return null;
                const result = claimContinuation.run(
                  record.leaseExpiresAt,
                  record.now,
                  pending.id,
                );
                if (result.changes !== 1) return null;
                const claimed = selectContinuationById.get(pending.id);
                return claimed === undefined ? null : decodeContinuation(claimed);
              });
              return transaction();
            },
            catch: (cause) =>
              new GoalPersistenceError({
                message: `Could not claim Continuation: ${messageFromCause(cause)}`,
              }),
          }),
      );

      const markContinuationSendingClaim = Effect.fn(
        "GoalRepository.markContinuationSending",
      )((record: MarkGoalContinuationSendingRecord) =>
        Effect.try({
          try: () =>
            markContinuationSending.run(
              record.deliveryMarker,
              record.leaseExpiresAt,
              record.now,
              record.id,
            ).changes === 1,
          catch: (cause) =>
            new GoalPersistenceError({
              message: `Could not mark Continuation as sending: ${messageFromCause(cause)}`,
            }),
        }),
      );

      const resolveContinuationClaim = Effect.fn("GoalRepository.resolveContinuation")(
        (record: ResolveGoalContinuationRecord) =>
          Effect.try({
            try: () =>
              resolveContinuation.run(
                record.outcome,
                record.reason,
                record.now,
                record.id,
              ).changes === 1,
            catch: (cause) =>
              new GoalPersistenceError({
                message: `Could not resolve Continuation: ${messageFromCause(cause)}`,
              }),
          }),
      );

      return GoalRepository.of({
        current,
        history,
        find,
        start,
        mutate,
        delete: deleteGoal,
        recordFailure: recordFailureEffect,
        dueUsageLimits,
        recoverUsageLimit: recoverUsageLimitEffect,
        nextUsageLimitReset,
        enqueueContinuation,
        recoverContinuations,
        sendingContinuations,
        requeueContinuation: requeueContinuationClaim,
        claimContinuation: claimNextContinuation,
        markContinuationSending: markContinuationSendingClaim,
        resolveContinuation: resolveContinuationClaim,
        unassessedSentContinuations,
        assessContinuation,
      });
    }),
  );
}
