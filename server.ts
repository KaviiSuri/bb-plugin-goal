import { isAbsolute, resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  GOAL_HISTORY_DEFAULT_LIMIT,
  GOAL_HISTORY_MAX_LIMIT,
  goalStates,
  type GoalCommandResult,
  type GoalDto,
  type GoalHistoryPage,
  type GoalMutationType,
} from "./src/domain";
import {
  GOAL_MIGRATIONS,
  makeCurrentGoalSnapshotReader,
} from "./src/repository";
import {
  makeGoalRuntime,
  type GoalRuntime,
} from "./src/runtime";
import type { GoalThreadGatewayAdapter } from "./src/coordinator";
import {
  classifyGoalFailureWithIdentity,
  type ClassifiedGoalFailure,
} from "./src/failure";
import type { GoalFailureEventIdentity } from "./src/domain";

export const GOAL_REALTIME_CHANNEL = "goal.changed";

const goalSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    objective: z.string(),
    state: z.enum(goalStates),
    revision: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().nullable(),
    completionSummary: z.string().nullable(),
    verificationEvidence: z.string().nullable(),
    blockageExternalAction: z.string().nullable(),
    blockageEvidence: z.string().nullable(),
    blockageRepeatedTurns: z.number().int().nullable(),
    pauseReasonCode: z.enum(["manual", "failure", "usage-limit"]).nullable(),
    pauseReason: z.string().nullable(),
    usageLimitKind: z
      .enum(["subscription-window", "credits", "spend-control", "unknown"])
      .nullable(),
    usageResetAt: z.string().nullable(),
  })
  .strict();

export const goalCompleteInputSchema = z
  .object({
    goalId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    summary: z.string().trim().min(1),
    verificationEvidence: z.string().trim().min(1),
  })
  .strict();

export const goalBlockedInputSchema = z
  .object({
    goalId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    externalAction: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    repeatedTurns: z.number().int().min(1),
  })
  .strict();

const goalGuardSchema = {
  threadId: z.string().min(1),
  goalId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
};

export const rpcContract = defineRpcContract({
  start: {
    input: z
      .object({ threadId: z.string().min(1), objective: z.string().min(1) })
      .strict(),
    output: z.object({ goal: goalSchema }).strict(),
  },
  status: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ goal: goalSchema.nullable() }).strict(),
  },
  edit: {
    input: z
      .object({ ...goalGuardSchema, objective: z.string().min(1) })
      .strict(),
    output: z.object({ goal: goalSchema }).strict(),
  },
  pause: {
    input: z.object(goalGuardSchema).strict(),
    output: z.object({ goal: goalSchema }).strict(),
  },
  resume: {
    input: z.object(goalGuardSchema).strict(),
    output: z.object({ goal: goalSchema }).strict(),
  },
  cancel: {
    input: z.object(goalGuardSchema).strict(),
    output: z.object({ goal: goalSchema }).strict(),
  },
  history: {
    input: z
      .object({
        threadId: z.string().min(1),
        limit: z.number().int().min(1).max(GOAL_HISTORY_MAX_LIMIT),
        cursor: z.string().min(1).nullable(),
      })
      .strict(),
    output: z
      .object({
        goals: z.array(goalSchema),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  },
  show: {
    input: z.object({ goalId: z.string().min(1) }).strict(),
    output: z.object({ goal: goalSchema }).strict(),
  },
  delete: {
    input: z.object(goalGuardSchema).strict(),
    output: z.object({ goal: goalSchema }).strict(),
  },
});

interface PluginDependencies {
  readonly makeRuntime: (
    database: BetterSqlite3.Database,
    gateway: GoalThreadGatewayAdapter,
  ) => GoalRuntime;
}

const liveDependencies: PluginDependencies = { makeRuntime: makeGoalRuntime };

class CliUsageError extends Error {}

function requireGoalSuccessful(result: GoalCommandResult): GoalDto | null {
  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }
  if (!("goal" in result)) {
    throw new Error("Goal command returned history instead of a Goal.");
  }
  return result.goal;
}

function requireHistorySuccessful(result: GoalCommandResult): GoalHistoryPage {
  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }
  if (!("page" in result)) {
    throw new Error("Goal history command returned a Goal instead of history.");
  }
  return result.page;
}

function formatGoal(goal: GoalDto, heading: string): string {
  return [
    heading,
    `ID: ${goal.id}`,
    `Thread: ${goal.threadId}`,
    `State: ${goal.state}`,
    `Revision: ${goal.revision}`,
    `Objective: ${goal.objective}`,
    ...(goal.completionSummary === null
      ? []
      : [`Completion summary: ${goal.completionSummary}`]),
    ...(goal.verificationEvidence === null
      ? []
      : [`Verification evidence: ${goal.verificationEvidence}`]),
    ...(goal.blockageExternalAction === null
      ? []
      : [`External action required: ${goal.blockageExternalAction}`]),
    ...(goal.blockageEvidence === null
      ? []
      : [`Blockage evidence: ${goal.blockageEvidence}`]),
    ...(goal.blockageRepeatedTurns === null
      ? []
      : [`Repeated blocker turns: ${goal.blockageRepeatedTurns}`]),
    ...(goal.pauseReason === null
      ? []
      : [`Pause reason: ${goal.pauseReason}`]),
    ...(goal.usageLimitKind === null
      ? []
      : [`Usage limit: ${goal.usageLimitKind}`]),
    ...(goal.usageResetAt === null
      ? goal.pauseReasonCode === "usage-limit"
        ? ["Manual resume required: yes"]
        : []
      : [`Usage reset at: ${goal.usageResetAt}`]),
  ].join("\n");
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function resultExitCode(result: GoalCommandResult): number {
  if (result.ok) return 0;
  switch (result.error.code) {
    case "invalid_arguments":
    case "invalid_cursor":
    case "invalid_objective":
    case "invalid_completion":
    case "invalid_blockage":
      return 2;
    case "thread_not_found":
    case "goal_not_found":
      return 3;
    case "goal_already_exists":
    case "stale_goal":
    case "invalid_transition":
      return 4;
    case "persistence_error":
    case "gateway_error":
      return 1;
  }
}

function commandResult(
  result: GoalCommandResult,
  json: boolean,
  successHeading: string,
  emptyMessage: string,
): PluginCliResult {
  const exitCode = resultExitCode(result);
  if (!result.ok) {
    return {
      exitCode,
      stderr: json
        ? jsonLine({ ok: false, error: result.error })
        : `${result.error.message}\n`,
    };
  }
  if (!("goal" in result)) {
    return { exitCode: 1, stderr: "Goal command returned invalid output.\n" };
  }
  if (json) return { exitCode: 0, stdout: jsonLine({ goal: result.goal }) };
  return {
    exitCode: 0,
    stdout:
      result.goal === null
        ? `${emptyMessage}\n`
        : `${formatGoal(result.goal, successHeading)}\n`,
  };
}

function historyResult(
  result: GoalCommandResult,
  json: boolean,
  threadId: string,
): PluginCliResult {
  const exitCode = resultExitCode(result);
  if (!result.ok) {
    return {
      exitCode,
      stderr: json
        ? jsonLine({ ok: false, error: result.error })
        : `${result.error.message}\n`,
    };
  }
  if (!("page" in result)) {
    return { exitCode: 1, stderr: "Goal history returned invalid output.\n" };
  }
  if (json) return { exitCode: 0, stdout: jsonLine(result.page) };
  if (result.page.goals.length === 0) {
    return { exitCode: 0, stdout: `No Goal history for thread ${threadId}.\n` };
  }
  const output = result.page.goals
    .map((goal, index) => formatGoal(goal, index === 0 ? "Goal History" : "---"))
    .join("\n");
  return {
    exitCode: 0,
    stdout: `${output}${
      result.page.nextCursor === null
        ? ""
        : `\nNext cursor: ${result.page.nextCursor}`
    }\n`,
  };
}

interface ParsedOptions {
  readonly json: boolean;
  readonly objectiveFile: string | null;
  readonly limit: number | null;
  readonly cursor: string | null;
  readonly yes: boolean;
  readonly positional: string[];
}

interface AllowedOptions {
  readonly objectiveFile?: boolean;
  readonly pagination?: boolean;
  readonly yes?: boolean;
}

function parseOptions(
  argv: string[],
  allowed: AllowedOptions = {},
): ParsedOptions {
  let json = false;
  let objectiveFile: string | null = null;
  let limit: number | null = null;
  let cursor: string | null = null;
  let yes = false;
  const positional: string[] = [];

  const takeValue = (index: number, option: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${option} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--yes") {
      if (!allowed.yes) {
        throw new CliUsageError("--yes is valid only for goal delete.");
      }
      yes = true;
      continue;
    }
    if (
      argument === "--objective-file" ||
      argument.startsWith("--objective-file=")
    ) {
      if (!allowed.objectiveFile) {
        throw new CliUsageError("--objective-file is valid only for goal start.");
      }
      if (objectiveFile !== null) {
        throw new CliUsageError("--objective-file may be provided only once.");
      }
      objectiveFile = argument.includes("=")
        ? argument.slice("--objective-file=".length)
        : takeValue(index, "--objective-file");
      if (!argument.includes("=")) index += 1;
      if (objectiveFile.length === 0) {
        throw new CliUsageError("--objective-file requires a path.");
      }
      continue;
    }
    if (argument === "--limit" || argument.startsWith("--limit=")) {
      if (!allowed.pagination) {
        throw new CliUsageError("--limit is valid only for goal history.");
      }
      if (limit !== null) {
        throw new CliUsageError("--limit may be provided only once.");
      }
      const raw = argument.includes("=")
        ? argument.slice("--limit=".length)
        : takeValue(index, "--limit");
      if (!argument.includes("=")) index += 1;
      limit = Number(raw);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > GOAL_HISTORY_MAX_LIMIT
      ) {
        throw new CliUsageError(
          `--limit must be an integer between 1 and ${GOAL_HISTORY_MAX_LIMIT}.`,
        );
      }
      continue;
    }
    if (argument === "--cursor" || argument.startsWith("--cursor=")) {
      if (!allowed.pagination) {
        throw new CliUsageError("--cursor is valid only for goal history.");
      }
      if (cursor !== null) {
        throw new CliUsageError("--cursor may be provided only once.");
      }
      cursor = argument.includes("=")
        ? argument.slice("--cursor=".length)
        : takeValue(index, "--cursor");
      if (!argument.includes("=")) index += 1;
      if (cursor.length === 0) {
        throw new CliUsageError("--cursor requires a value.");
      }
      continue;
    }
    if (argument.startsWith("--")) {
      throw new CliUsageError(`Unknown option ${argument}.`);
    }
    positional.push(argument);
  }

  return { json, objectiveFile, limit, cursor, yes, positional };
}

function resolveThreadId(
  explicit: string | undefined,
  ctx: PluginCliContext,
): string {
  const threadId = explicit ?? ctx.threadId;
  if (threadId === undefined) {
    throw new CliUsageError(
      "No thread ID was provided and no current BB thread context is available.",
    );
  }
  return threadId;
}

async function invokingHostId(
  bb: BbPluginApi,
  ctx: PluginCliContext,
): Promise<string | undefined> {
  if (ctx.threadId === undefined) return undefined;
  const thread = await bb.sdk.threads.get({
    threadId: ctx.threadId,
    signal: ctx.signal,
  });
  if (thread.environmentId === null) return undefined;
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
    signal: ctx.signal,
  });
  return environment.hostId;
}

async function readObjectiveFile(
  bb: BbPluginApi,
  path: string,
  ctx: PluginCliContext,
): Promise<string> {
  const absolutePath = isAbsolute(path)
    ? path
    : ctx.cwd === undefined
      ? (() => {
          throw new CliUsageError(
            "A relative objective file requires CLI working-directory context.",
          );
        })()
      : resolve(ctx.cwd, path);
  const hostId = await invokingHostId(bb, ctx);
  const file = await bb.sdk.files.read({
    ...(hostId === undefined ? {} : { hostId }),
    path: absolutePath,
    signal: ctx.signal,
  });
  return file.contentEncoding === "base64"
    ? Buffer.from(file.content, "base64").toString("utf8")
    : file.content;
}

function goalAgentInstructions(goal: GoalDto): string {
  const rules = [
    "An active BB Goal governs this thread.",
    `Exact Goal ID: ${goal.id}`,
    `Goal revision: ${goal.revision}`,
    "Keep working until the full objective is complete. Do not stop after only a plan or partial progress.",
    "Only the user may edit, pause, resume, cancel, or delete this Goal.",
    "Call goal_complete only after every requirement is satisfied and verified. Pass the exact Goal ID and revision shown here, a concrete completion summary, and verification evidence.",
    "Call goal_blocked only for a genuine external impasse that requires a user or external action. Do not use it for ordinary difficulty, uncertainty, provider failures, usage limits, pending interactions, or a blocker that changed. The same external blocker must persist for at least three consecutive Goal turns. Pass the exact Goal ID and revision, the required external action, concrete evidence, and the repeated-turn count.",
    "A stale Goal ID or revision cannot complete or block an edited, terminal, or replacement Goal.",
    "Objective:",
  ].join("\n");
  const maxLength = 4096;
  const remaining = Math.max(0, maxLength - rules.length - 1);
  const truncationMarker = "\n[Objective truncated by BB limit]";
  const objective =
    goal.objective.length <= remaining
      ? goal.objective
      : `${goal.objective.slice(
          0,
          Math.max(0, remaining - truncationMarker.length),
        )}${truncationMarker}`;
  return `${rules}\n${objective}`;
}

function goalCompleteParameters(goal: GoalDto): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "goalId",
      "expectedRevision",
      "summary",
      "verificationEvidence",
    ],
    properties: {
      goalId: { type: "string", const: goal.id },
      expectedRevision: { type: "integer", const: goal.revision },
      summary: { type: "string", minLength: 1 },
      verificationEvidence: { type: "string", minLength: 1 },
    },
  };
}

function goalBlockedParameters(goal: GoalDto): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "goalId",
      "expectedRevision",
      "externalAction",
      "evidence",
      "repeatedTurns",
    ],
    properties: {
      goalId: { type: "string", const: goal.id },
      expectedRevision: { type: "integer", const: goal.revision },
      externalAction: { type: "string", minLength: 1 },
      evidence: { type: "string", minLength: 1 },
      repeatedTurns: { type: "integer", minimum: 1 },
    },
  };
}

function publishGoalChanged(
  bb: BbPluginApi,
  goal: GoalDto,
  deleted = false,
): void {
  bb.realtime.publish(GOAL_REALTIME_CHANNEL, {
    threadId: goal.threadId,
    goalId: goal.id,
    revision: goal.revision,
    state: goal.state,
    deleted,
  });
}

async function runStart(
  bb: BbPluginApi,
  runtime: GoalRuntime,
  argv: string[],
  ctx: PluginCliContext,
): Promise<PluginCliResult> {
  const options = parseOptions(argv, { objectiveFile: true });
  const firstIsThread = options.positional[0]?.startsWith("thr_") ?? false;
  const explicitThread = firstIsThread ? options.positional[0] : undefined;
  const objectiveWords = options.positional.slice(firstIsThread ? 1 : 0);

  if (options.objectiveFile !== null && objectiveWords.length > 0) {
    throw new CliUsageError(
      "Provide an objective as text or with --objective-file, not both.",
    );
  }
  if (options.objectiveFile === null && objectiveWords.length === 0) {
    throw new CliUsageError(
      "Usage: bb goal start [thread-id] <objective> [--objective-file <path>] [--json]",
    );
  }

  const threadId = resolveThreadId(explicitThread, ctx);
  const objective =
    options.objectiveFile === null
      ? objectiveWords.join(" ")
      : await readObjectiveFile(bb, options.objectiveFile, ctx);
  const result = await runtime.run({ type: "start", threadId, objective });
  if (result.ok && "goal" in result && result.goal !== null) {
    publishGoalChanged(bb, result.goal);
  }
  return commandResult(
    result,
    options.json,
    "Started Goal",
    `No unfinished Goal for thread ${threadId}.`,
  );
}

async function runStatus(
  runtime: GoalRuntime,
  argv: string[],
  ctx: PluginCliContext,
): Promise<PluginCliResult> {
  const options = parseOptions(argv);
  if (options.positional.length > 1) {
    throw new CliUsageError("Usage: bb goal status [thread-id] [--json]");
  }
  const threadId = resolveThreadId(options.positional[0], ctx);
  const result = await runtime.run({ type: "status", threadId });
  return commandResult(
    result,
    options.json,
    "Active Goal",
    `No unfinished Goal for thread ${threadId}.`,
  );
}

function missingCurrentGoal(threadId: string): GoalCommandResult {
  return {
    ok: false,
    error: {
      code: "goal_not_found",
      message: `No unfinished Goal for thread ${threadId}.`,
    },
  };
}

async function runMutation(
  bb: BbPluginApi,
  runtime: GoalRuntime,
  type: GoalMutationType,
  argv: string[],
  ctx: PluginCliContext,
): Promise<PluginCliResult> {
  const options = parseOptions(argv);
  const firstIsThread = options.positional[0]?.startsWith("thr_") ?? false;
  const explicitThread = firstIsThread ? options.positional[0] : undefined;
  const remaining = options.positional.slice(firstIsThread ? 1 : 0);

  if (type === "edit") {
    if (remaining.length === 0) {
      throw new CliUsageError(
        "Usage: bb goal edit [thread-id] <objective> [--json]",
      );
    }
  } else if (remaining.length > 0) {
    throw new CliUsageError(`Usage: bb goal ${type} [thread-id] [--json]`);
  }

  const threadId = resolveThreadId(explicitThread, ctx);
  const status = await runtime.run({ type: "status", threadId });
  if (!status.ok) return commandResult(status, options.json, "", "");
  if (!("goal" in status)) {
    return { exitCode: 1, stderr: "Goal status returned invalid output.\n" };
  }
  if (status.goal === null) {
    return commandResult(missingCurrentGoal(threadId), options.json, "", "");
  }

  const guard = {
    threadId,
    goalId: status.goal.id,
    expectedRevision: status.goal.revision,
  };
  const result =
    type === "edit"
      ? await runtime.run({
          type,
          ...guard,
          objective: remaining.join(" "),
        })
      : await runtime.run({ type, ...guard });
  if (result.ok && "goal" in result && result.goal !== null) {
    publishGoalChanged(bb, result.goal);
  }

  const headings: Record<GoalMutationType, string> = {
    edit: "Edited Goal",
    pause: "Paused Goal",
    resume: "Resumed Goal",
    cancel: "Canceled Goal",
  };
  return commandResult(result, options.json, headings[type], "");
}

async function runHistory(
  runtime: GoalRuntime,
  argv: string[],
  ctx: PluginCliContext,
): Promise<PluginCliResult> {
  const options = parseOptions(argv, { pagination: true });
  if (options.positional.length > 1) {
    throw new CliUsageError(
      "Usage: bb goal history [thread-id] [--limit <n>] [--cursor <cursor>] [--json]",
    );
  }
  const threadId = resolveThreadId(options.positional[0], ctx);
  const result = await runtime.run({
    type: "history",
    threadId,
    limit: options.limit ?? GOAL_HISTORY_DEFAULT_LIMIT,
    cursor: options.cursor,
  });
  return historyResult(result, options.json, threadId);
}

async function runShow(
  runtime: GoalRuntime,
  argv: string[],
): Promise<PluginCliResult> {
  const options = parseOptions(argv);
  if (options.positional.length !== 1) {
    throw new CliUsageError("Usage: bb goal show <goal-id> [--json]");
  }
  const result = await runtime.run({
    type: "show",
    goalId: options.positional[0]!,
  });
  return commandResult(result, options.json, "Goal", "");
}

async function runDelete(
  bb: BbPluginApi,
  runtime: GoalRuntime,
  argv: string[],
): Promise<PluginCliResult> {
  const options = parseOptions(argv, { yes: true });
  if (options.positional.length !== 1) {
    throw new CliUsageError(
      "Usage: bb goal delete <goal-id> --yes [--json]",
    );
  }
  if (!options.yes) {
    throw new CliUsageError("Deleting a Goal requires --yes.");
  }

  const shown = await runtime.run({
    type: "show",
    goalId: options.positional[0]!,
  });
  if (!shown.ok) return commandResult(shown, options.json, "", "");
  if (!("goal" in shown) || shown.goal === null) {
    return { exitCode: 1, stderr: "Goal show returned invalid output.\n" };
  }
  const result = await runtime.run({
    type: "delete",
    threadId: shown.goal.threadId,
    goalId: shown.goal.id,
    expectedRevision: shown.goal.revision,
  });
  if (result.ok && "goal" in result && result.goal !== null) {
    publishGoalChanged(bb, result.goal, true);
  }
  return commandResult(result, options.json, "Deleted Goal", "");
}

async function runCli(
  bb: BbPluginApi,
  runtime: GoalRuntime,
  argv: string[],
  ctx: PluginCliContext,
): Promise<PluginCliResult> {
  const json = argv.includes("--json");
  try {
    const [command, ...rest] = argv;
    if (command === "start") return await runStart(bb, runtime, rest, ctx);
    if (command === "status") return await runStatus(runtime, rest, ctx);
    if (command === "history") return await runHistory(runtime, rest, ctx);
    if (command === "show") return await runShow(runtime, rest);
    if (command === "delete") return await runDelete(bb, runtime, rest);
    if (
      command === "edit" ||
      command === "pause" ||
      command === "resume" ||
      command === "cancel"
    ) {
      return await runMutation(bb, runtime, command, rest, ctx);
    }
    throw new CliUsageError(
      "Usage: bb goal <start|status|edit|pause|resume|cancel|history|show|delete> ...",
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      exitCode: cause instanceof CliUsageError ? 2 : 1,
      stderr: json
        ? jsonLine({
            ok: false,
            error: {
              code:
                cause instanceof CliUsageError
                  ? "invalid_arguments"
                  : "adapter_error",
              message,
            },
          })
        : `${message}\n`,
    };
  }
}

type ThreadFailureClassification = ClassifiedGoalFailure & {
  readonly observedEvents: ReadonlyArray<GoalFailureEventIdentity>;
};

async function classifyThreadFailure(
  bb: BbPluginApi,
  threadId: string,
  fallbackMessage: string | null,
  lifecycleCreatedAtMs: number,
  signal?: AbortSignal,
): Promise<ThreadFailureClassification> {
  const events = await bb.sdk.threads.events.list({
    threadId,
    order: "desc",
    limit: "50",
    types: [
      "provider/error",
      "provider/rateLimits/updated",
      "system/error",
      "turn/started",
      "turn/completed",
    ],
    signal,
  });
  const latestTurnEvent = events
    .filter(
      (event) =>
        event.scope.kind === "turn" &&
        (event.type === "turn/started" || event.type === "turn/completed"),
    )
    .sort((left, right) => right.seq - left.seq)[0];
  const currentTurnId =
    latestTurnEvent?.scope.kind === "turn"
      ? latestTurnEvent.scope.turnId
      : null;
  const structuredEvents = events
    .filter((event) =>
      ["provider/error", "provider/rateLimits/updated", "system/error"].includes(
        event.type,
      ),
    )
    .map((event) => ({
      id: event.id,
      seq: event.seq,
      createdAt: event.createdAt,
      turnId: event.scope.kind === "turn" ? event.scope.turnId : null,
      type: event.type,
      data: event.data,
    }));
  const lifecycleEvent: GoalFailureEventIdentity = {
    id: `thread.failed:${threadId}:${currentTurnId ?? lifecycleCreatedAtMs}`,
    seq: null,
    createdAt: lifecycleCreatedAtMs,
    turnId: currentTurnId,
  };
  const correlatedStructuredEvents =
    currentTurnId === null && fallbackMessage !== null
      ? []
      : structuredEvents;
  const classified = classifyGoalFailureWithIdentity(
    correlatedStructuredEvents,
    Date.now(),
    fallbackMessage,
    currentTurnId,
  );
  return {
    ...classified,
    event: classified.event ?? lifecycleEvent,
    observedEvents: [
      ...structuredEvents.map(({ id, seq, createdAt, turnId }) => ({
        id,
        seq,
        createdAt,
        turnId,
      })),
      lifecycleEvent,
    ],
  };
}

export function createPlugin(
  dependencies: PluginDependencies = liveDependencies,
): (bb: BbPluginApi) => Promise<void> {
  return async function goalPlugin(bb) {
    const database = bb.storage.database();
    bb.storage.migrate(database, [...GOAL_MIGRATIONS]);

    const runtime = dependencies.makeRuntime(database, {
      async threadExists(threadId) {
        try {
          await bb.sdk.threads.get({ threadId });
          return true;
        } catch {
          return false;
        }
      },
      async readThread(threadId, signal) {
        const [thread, queuedMessages, interactions, timeline] =
          await Promise.all([
            bb.sdk.threads.get({ threadId, signal }),
            bb.sdk.threads.queuedMessages.list({ threadId, signal }),
            bb.sdk.threads.interactions.list({ threadId, signal }),
            bb.sdk.threads.timeline({
              threadId,
              signal,
              segmentLimit: "1",
              summaryOnly: "false",
            }),
          ]);
        return {
          status: thread.status,
          runtimeStatus: thread.runtime.displayStatus,
          queuedMessageCount: queuedMessages.length,
          activePromptMode: timeline.activePromptMode?.mode ?? null,
          pendingInteractionCount: interactions.filter(
            (interaction) =>
              interaction.status !== "resolved" &&
              interaction.status !== "interrupted",
          ).length,
        };
      },
      async sendContinuation(threadId, deliveryMarker, signal) {
        if (signal?.aborted === true) {
          throw new Error("Goal plugin is shutting down.");
        }
        await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [
            {
              type: "text",
              text:
                "Continue working toward the active BB Goal. Re-read the objective and make the next meaningful step. Do not stop unless the Goal is complete or genuinely blocked. " +
                `Internal delivery marker: ${deliveryMarker}`,
              mentions: [],
              visibility: "agent-only",
            },
          ],
        });
      },
      async reconcileContinuation(threadId, deliveryMarker, signal) {
        const timeline = await bb.sdk.threads.timeline({
          threadId,
          signal,
          segmentLimit: "100",
          summaryOnly: "false",
        });
        return timeline.rows.some(
          (row) => "text" in row && row.text.includes(deliveryMarker),
        );
      },
    });

    const CONTINUATION_RETRY_BASE_MS = 25;
    const CONTINUATION_RETRY_MAX_MS = 1_000;
    let disposed = false;
    let wakeWorker: (() => void) | null = null;
    const pendingIdleEvents = new Map<
      string,
      { readonly threadId: string; readonly opportunityKey: string }
    >();
    const pendingIdleEventKey = (threadId: string, opportunityKey: string) =>
      `${threadId}\u0000${opportunityKey}`;
    const wake = () => {
      const resolve = wakeWorker;
      wakeWorker = null;
      resolve?.();
    };
    const waitForWork = (
      signal: AbortSignal,
      timeoutMs: number | null = null,
    ): Promise<void> => {
      if (signal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          if (wakeWorker === finish) wakeWorker = null;
          resolve();
        };
        wakeWorker = finish;
        signal.addEventListener("abort", finish, { once: true });
        if (timeoutMs !== null) timer = setTimeout(finish, timeoutMs);
      });
    };

    const retryPendingIdleEvents = async (signal: AbortSignal) => {
      for (const [pendingKey, event] of pendingIdleEvents) {
        if (signal.aborted) return;
        await runtime.enqueueIdle(event.threadId, event.opportunityKey);
        pendingIdleEvents.delete(pendingKey);
      }
    };

    bb.events.on("thread.idle", async ({ thread }) => {
      if (disposed) return;
      const opportunityKey = `idle:${thread.updatedAt}`;
      const pendingKey = pendingIdleEventKey(thread.id, opportunityKey);
      try {
        await runtime.enqueueIdle(thread.id, opportunityKey);
        pendingIdleEvents.delete(pendingKey);
        wake();
      } catch (cause) {
        if (disposed) return;
        pendingIdleEvents.set(pendingKey, {
          threadId: thread.id,
          opportunityKey,
        });
        bb.log.error(
          `Could not enqueue idle Continuation: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
        wake();
      }
    });

    bb.events.on("thread.failed", async ({ thread, error }) => {
      if (disposed) return;
      try {
        const classified = await classifyThreadFailure(
          bb,
          thread.id,
          error,
          thread.updatedAt,
        );
        const goal = await runtime.recordFailure(
          thread.id,
          classified.failure,
          classified.event ?? undefined,
          classified.observedEvents,
        );
        if (goal !== null) publishGoalChanged(bb, goal);
        wake();
      } catch (cause) {
        if (!disposed) {
          bb.log.error(
            `Could not record failed Goal turn: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }
    });

    bb.background.service("continuations", {
      async start(signal) {
        let retryDelayMs = CONTINUATION_RETRY_BASE_MS;
        while (!signal.aborted) {
          try {
            await retryPendingIdleEvents(signal);
            const recoveredGoals = await runtime.recoverUsageLimits();
            for (const goal of recoveredGoals) {
              await runtime.enqueueIdle(
                goal.threadId,
                `usage-reset:${goal.id}:${goal.revision}`,
              );
            }
            await runtime.recoverContinuations();
            let claimed = false;
            do {
              claimed = await runtime.processContinuation(signal);
            } while (claimed && !signal.aborted);
            retryDelayMs = CONTINUATION_RETRY_BASE_MS;
            if (!signal.aborted) {
              const nextReset = await runtime.nextUsageLimitReset();
              const parsedReset = nextReset === null ? Number.NaN : Date.parse(nextReset);
              const waitMs = Number.isFinite(parsedReset)
                ? Math.max(0, parsedReset - Date.now())
                : null;
              if (pendingIdleEvents.size > 0) continue;
              await waitForWork(signal, waitMs);
            }
          } catch (cause) {
            if (signal.aborted) break;
            bb.log.error(
              `Continuation worker recovered from an error: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            );
            await waitForWork(signal, retryDelayMs);
            retryDelayMs = Math.min(
              retryDelayMs * 2,
              CONTINUATION_RETRY_MAX_MS,
            );
          }
        }
      },
    });
    const snapshots = makeCurrentGoalSnapshotReader(database);

    bb.agents.registerTool({
      name: "goal_complete",
      description:
        "Mark the active BB Goal completed after all required work is done and verified.",
      instructions:
        "Use only for the active BB Goal. Include its exact ID and revision, a completion summary, and concrete verification evidence.",
      experimental_statusLabels: {
        pending: "Completing Goal",
        completed: "Completed Goal",
      },
      parameters: goalCompleteInputSchema,
      async execute(input, context) {
        const goal = requireGoalSuccessful(
          await runtime.run({
            type: "complete",
            threadId: context.threadId,
            ...input,
          }),
        );
        if (goal === null) throw new Error("Goal Completion returned no Goal.");
        publishGoalChanged(bb, goal);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ goal }),
            },
          ],
        };
      },
    });

    bb.agents.registerTool({
      name: "goal_blocked",
      description:
        "Report a genuine external Blockage after the same blocker persists for at least three consecutive Goal turns.",
      instructions:
        "Use only for a genuine external impasse. Include the exact Goal ID and revision, the required external action, concrete evidence, and the repeated-turn count. Do not use for ordinary difficulty, uncertainty, failures, usage limits, pending interactions, or changed blockers.",
      experimental_statusLabels: {
        pending: "Reporting Goal Blockage",
        completed: "Reported Goal Blockage",
      },
      parameters: goalBlockedInputSchema,
      async execute(input, context) {
        const goal = requireGoalSuccessful(
          await runtime.run({
            type: "block",
            threadId: context.threadId,
            ...input,
          }),
        );
        if (goal === null) throw new Error("Goal Blockage returned no Goal.");
        publishGoalChanged(bb, goal);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                goal,
                blockageReport:
                  goal.state === "blocked"
                    ? { status: "blocked", repeatedTurns: input.repeatedTurns }
                    : {
                        status: "qualifying",
                        repeatedTurns: input.repeatedTurns,
                        turnsRemaining: 3 - input.repeatedTurns,
                      },
              }),
            },
          ],
        };
      },
    });

    bb.agents.configure((context) => {
      const goal = snapshots.current(context.thread.id);
      if (goal === null || goal.state !== "active") {
        return { tools: [], skills: [] };
      }
      return {
        tools: [
          {
            name: "goal_complete",
            parameters: goalCompleteParameters(goal),
          },
          {
            name: "goal_blocked",
            parameters: goalBlockedParameters(goal),
          },
        ],
        skills: [],
        instructions: goalAgentInstructions(goal),
      };
    });

    async function mutate(
      command:
        | {
            readonly type: "edit";
            readonly threadId: string;
            readonly goalId: string;
            readonly expectedRevision: number;
            readonly objective: string;
          }
        | {
            readonly type: "pause" | "resume" | "cancel";
            readonly threadId: string;
            readonly goalId: string;
            readonly expectedRevision: number;
          },
    ): Promise<{ goal: GoalDto }> {
      const goal = requireGoalSuccessful(await runtime.run(command));
      if (goal === null) {
        throw new Error(`Goal ${command.type} returned no Goal.`);
      }
      publishGoalChanged(bb, goal);
      return { goal };
    }

    bb.rpc.register(rpcContract, {
      async start(input) {
        const goal = requireGoalSuccessful(
          await runtime.run({
            type: "start",
            threadId: input.threadId,
            objective: input.objective,
          }),
        );
        if (goal === null) throw new Error("Goal start returned no Goal.");
        publishGoalChanged(bb, goal);
        return { goal };
      },
      async status(input) {
        const goal = requireGoalSuccessful(
          await runtime.run({ type: "status", threadId: input.threadId }),
        );
        return { goal };
      },
      edit: (input) => mutate({ type: "edit", ...input }),
      pause: (input) => mutate({ type: "pause", ...input }),
      resume: (input) => mutate({ type: "resume", ...input }),
      cancel: (input) => mutate({ type: "cancel", ...input }),
      async history(input) {
        const page = requireHistorySuccessful(
          await runtime.run({ type: "history", ...input }),
        );
        return { goals: [...page.goals], nextCursor: page.nextCursor };
      },
      async show(input) {
        const goal = requireGoalSuccessful(
          await runtime.run({ type: "show", goalId: input.goalId }),
        );
        if (goal === null) throw new Error("Goal show returned no Goal.");
        return { goal };
      },
      async delete(input) {
        const goal = requireGoalSuccessful(
          await runtime.run({ type: "delete", ...input }),
        );
        if (goal === null) throw new Error("Goal delete returned no Goal.");
        publishGoalChanged(bb, goal, true);
        return { goal };
      },
    });

    bb.cli.register({
      name: "goal",
      summary: "Start, inspect, and control durable thread Goals",
      commands: [
        {
          name: "start",
          summary: "Start a Goal on an existing thread",
          usage:
            "bb goal start [thread-id] <objective> [--objective-file <path>] [--json]",
        },
        {
          name: "status",
          summary: "Inspect the unfinished Goal for a thread",
          usage: "bb goal status [thread-id] [--json]",
        },
        {
          name: "edit",
          summary: "Edit the unfinished Goal objective",
          usage: "bb goal edit [thread-id] <objective> [--json]",
        },
        {
          name: "pause",
          summary: "Pause an active Goal",
          usage: "bb goal pause [thread-id] [--json]",
        },
        {
          name: "resume",
          summary: "Resume a paused Goal",
          usage: "bb goal resume [thread-id] [--json]",
        },
        {
          name: "cancel",
          summary: "Cancel an unfinished Goal",
          usage: "bb goal cancel [thread-id] [--json]",
        },
        {
          name: "history",
          summary: "Browse a thread's Goal history",
          usage:
            "bb goal history [thread-id] [--limit <n>] [--cursor <cursor>] [--json]",
        },
        {
          name: "show",
          summary: "Inspect one Goal by ID",
          usage: "bb goal show <goal-id> [--json]",
        },
        {
          name: "delete",
          summary: "Delete one Goal after explicit confirmation",
          usage: "bb goal delete <goal-id> --yes [--json]",
        },
      ],
      run: (argv, ctx) => runCli(bb, runtime, argv, ctx),
    });

    bb.onDispose(() => {
      disposed = true;
      wake();
      return runtime.dispose();
    });
    bb.log.info("Goal coordinator loaded");
  };
}

export default createPlugin();
