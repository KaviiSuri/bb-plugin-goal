import { isAbsolute, resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { goalStates, type GoalCommandResult, type GoalDto } from "./src/domain";
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
      return 3;
    case "goal_already_exists":
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
      stderr: jsonLine({ ok: false, error: result.error }),
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

function resolveThreadId(explicit: string | undefined, ctx: PluginCliContext): string {
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
  if (result.ok && result.goal !== null) {
    bb.realtime.publish(GOAL_REALTIME_CHANNEL, {
      threadId,
      goalId: result.goal.id,
    });
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
    throw new CliUsageError(
      "Usage: bb goal <start|status> ... Run bb goal start or bb goal status.",
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
        bb.realtime.publish(GOAL_REALTIME_CHANNEL, {
          threadId: input.threadId,
          goalId: goal.id,
        });
        return { goal };
      },
      async status(input) {
        const goal = requireSuccessful(
          await runtime.run({ type: "status", threadId: input.threadId }),
        );
        return { goal };
      },
    });

    bb.cli.register({
      name: "goal",
      summary: "Start and inspect durable thread Goals",
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
      ],
      run: (argv, ctx) => runCli(bb, runtime, argv, ctx),
    });

    bb.onDispose(() => runtime.dispose());
    bb.log.info("Goal coordinator loaded");
  };
}

export default createPlugin();
