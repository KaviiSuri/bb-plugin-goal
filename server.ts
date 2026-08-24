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
  goalStates,
  type GoalCommandResult,
  type GoalDto,
  type GoalMutationType,
} from "./src/domain";
import { GOAL_MIGRATIONS } from "./src/repository";
import { makeGoalRuntime, type GoalRuntime } from "./src/runtime";

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
});

interface PluginDependencies {
  readonly makeRuntime: (
    database: BetterSqlite3.Database,
    gateway: { readonly threadExists: (threadId: string) => Promise<boolean> },
  ) => GoalRuntime;
}

const liveDependencies: PluginDependencies = { makeRuntime: makeGoalRuntime };

class CliUsageError extends Error {}

function requireSuccessful(result: GoalCommandResult): GoalDto | null {
  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }
  return result.goal;
}

function formatGoal(goal: GoalDto, heading: string): string {
  return [
    heading,
    `ID: ${goal.id}`,
    `Thread: ${goal.threadId}`,
    `State: ${goal.state}`,
    `Revision: ${goal.revision}`,
    `Objective: ${goal.objective}`,
  ].join("\n");
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function resultExitCode(result: GoalCommandResult): number {
  if (result.ok) return 0;
  switch (result.error.code) {
    case "invalid_objective":
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
  if (json) return { exitCode: 0, stdout: jsonLine({ goal: result.goal }) };
  return {
    exitCode: 0,
    stdout:
      result.goal === null
        ? `${emptyMessage}\n`
        : `${formatGoal(result.goal, successHeading)}\n`,
  };
}

interface ParsedOptions {
  readonly json: boolean;
  readonly objectiveFile: string | null;
  readonly positional: string[];
}

function parseOptions(argv: string[], allowObjectiveFile: boolean): ParsedOptions {
  let json = false;
  let objectiveFile: string | null = null;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--objective-file") {
      if (!allowObjectiveFile) {
        throw new CliUsageError("--objective-file is valid only for goal start.");
      }
      const path = argv[index + 1];
      if (path === undefined) {
        throw new CliUsageError("--objective-file requires a path.");
      }
      objectiveFile = path;
      index += 1;
      continue;
    }
    if (argument.startsWith("--objective-file=")) {
      if (!allowObjectiveFile) {
        throw new CliUsageError("--objective-file is valid only for goal start.");
      }
      objectiveFile = argument.slice("--objective-file=".length);
      if (objectiveFile.length === 0) {
        throw new CliUsageError("--objective-file requires a path.");
      }
      continue;
    }
    if (argument.startsWith("--")) {
      throw new CliUsageError(`Unknown option ${argument}.`);
    }
    positional.push(argument);
  }

  return { json, objectiveFile, positional };
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

function publishGoalChanged(bb: BbPluginApi, goal: GoalDto): void {
  bb.realtime.publish(GOAL_REALTIME_CHANNEL, {
    threadId: goal.threadId,
    goalId: goal.id,
    revision: goal.revision,
    state: goal.state,
  });
}

async function runStart(
  bb: BbPluginApi,
  runtime: GoalRuntime,
  argv: string[],
  ctx: PluginCliContext,
): Promise<PluginCliResult> {
  const options = parseOptions(argv, true);
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
  if (result.ok && result.goal !== null) publishGoalChanged(bb, result.goal);
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
  const options = parseOptions(argv, false);
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
  const options = parseOptions(argv, false);
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
  if (result.ok && result.goal !== null) publishGoalChanged(bb, result.goal);

  const headings: Record<GoalMutationType, string> = {
    edit: "Edited Goal",
    pause: "Paused Goal",
    resume: "Resumed Goal",
    cancel: "Canceled Goal",
  };
  return commandResult(result, options.json, headings[type], "");
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
    if (
      command === "edit" ||
      command === "pause" ||
      command === "resume" ||
      command === "cancel"
    ) {
      return await runMutation(bb, runtime, command, rest, ctx);
    }
    throw new CliUsageError(
      "Usage: bb goal <start|status|edit|pause|resume|cancel> ...",
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
      const goal = requireSuccessful(await runtime.run(command));
      if (goal === null) throw new Error(`Goal ${command.type} returned no Goal.`);
      publishGoalChanged(bb, goal);
      return { goal };
    }

    bb.rpc.register(rpcContract, {
      async start(input) {
        const goal = requireSuccessful(
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
        const goal = requireSuccessful(
          await runtime.run({ type: "status", threadId: input.threadId }),
        );
        return { goal };
      },
      edit: (input) => mutate({ type: "edit", ...input }),
      pause: (input) => mutate({ type: "pause", ...input }),
      resume: (input) => mutate({ type: "resume", ...input }),
      cancel: (input) => mutate({ type: "cancel", ...input }),
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
      ],
      run: (argv, ctx) => runCli(bb, runtime, argv, ctx),
    });

    bb.onDispose(() => runtime.dispose());
    bb.log.info("Goal coordinator loaded");
  };
}

export default createPlugin();
