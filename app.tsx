import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  definePluginApp,
  useBbContext,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "./server";

const GOAL_REALTIME_CHANNEL = "goal.changed";

interface GoalView {
  readonly id: string;
  readonly threadId: string;
  readonly objective: string;
  readonly state: "active" | "paused" | "waiting" | "completed" | "blocked" | "canceled";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

type ViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "current"; readonly goal: GoalView }
  | { readonly kind: "error"; readonly message: string };

function messageFromCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Goal could not be loaded.";
}

export function GoalComposerRow() {
  const { threadId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [starting, setStarting] = useState(false);
  const [objective, setObjective] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (threadId === null) {
      setView({ kind: "error", message: "A Goal needs an existing thread." });
      return;
    }
    try {
      const result = await rpc.call("status", { threadId });
      setView(
        result.goal === null
          ? { kind: "empty" }
          : { kind: "current", goal: result.goal },
      );
    } catch (cause) {
      setView({ kind: "error", message: messageFromCause(cause) });
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setView({ kind: "loading" });
    void load();
  }, [load]);

  useRealtime(GOAL_REALTIME_CHANNEL, (payload) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "threadId" in payload &&
      payload.threadId === threadId
    ) {
      void load();
    }
  });

  async function startGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (threadId === null || objective.trim().length === 0) return;
    setSubmitting(true);
    try {
      const result = await rpc.call("start", { threadId, objective });
      setView({ kind: "current", goal: result.goal });
      setObjective("");
      setStarting(false);
    } catch (cause) {
      setView({ kind: "error", message: messageFromCause(cause) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      aria-label="Goal"
      className="border-t border-border/70 px-3 py-2 text-sm"
    >
      {view.kind === "loading" ? (
        <div className="flex min-h-8 items-center gap-2 text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground/60" />
          Loading Goal
        </div>
      ) : null}

      {view.kind === "empty" && !starting ? (
        <div className="flex min-h-8 items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="font-medium text-foreground">Goal</span>
            <span className="ml-2 text-muted-foreground">
              No unfinished objective
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={() => setStarting(true)}>
            Start Goal
          </Button>
        </div>
      ) : null}

      {view.kind === "empty" && starting ? (
        <form className="flex items-center gap-2" onSubmit={startGoal}>
          <label className="sr-only" htmlFor="goal-objective">
            Goal objective
          </label>
          <Input
            id="goal-objective"
            autoFocus
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="What should this thread finish?"
            className="h-8"
          />
          <Button
            size="sm"
            type="submit"
            disabled={submitting || objective.trim().length === 0}
          >
            {submitting ? "Starting" : "Start"}
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => setStarting(false)}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      {view.kind === "current" ? (
        <div className="flex min-h-8 items-center gap-3">
          <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-foreground">
            <span className="size-2 rounded-full bg-success" />
            Active Goal
          </span>
          <span className="min-w-0 truncate text-muted-foreground" title={view.goal.objective}>
            {view.goal.objective}
          </span>
        </div>
      ) : null}

      {view.kind === "error" ? (
        <div className="flex min-h-8 items-center justify-between gap-3 text-destructive">
          <span className="truncate">{view.message}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "goal-row",
    scopes: ["thread"],
    banners: [
      {
        id: "current-goal",
        chrome: "bare",
        component: GoalComposerRow,
      },
    ],
  });
});
