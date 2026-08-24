import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  definePluginApp,
  useBbContext,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "./server";

const GOAL_REALTIME_CHANNEL = "goal.changed";

type GoalState =
  | "active"
  | "paused"
  | "waiting"
  | "completed"
  | "blocked"
  | "canceled";
type GoalMutation = "edit" | "pause" | "resume" | "cancel";

interface GoalView {
  readonly id: string;
  readonly threadId: string;
  readonly objective: string;
  readonly state: GoalState;
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

function goalStateLabel(state: GoalState): string {
  switch (state) {
    case "active":
      return "Active Goal";
    case "paused":
      return "Paused Goal";
    case "waiting":
      return "Waiting Goal";
    case "completed":
      return "Completed Goal";
    case "blocked":
      return "Blocked Goal";
    case "canceled":
      return "Canceled Goal";
  }
}

export function GoalComposerRow() {
  const { threadId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [pending, setPending] = useState<"start" | GoalMutation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
      setActionError(null);
      setEditing(false);
    } catch (cause) {
      setView({ kind: "error", message: messageFromCause(cause) });
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setView({ kind: "loading" });
    void load();
  }, [load]);

  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (connectionState === "connected" && previous !== "connected") {
      void load();
    }
  }, [connectionState, load]);

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
    setPending("start");
    setActionError(null);
    try {
      const result = await rpc.call("start", { threadId, objective });
      setView({ kind: "current", goal: result.goal });
      setObjective("");
      setStarting(false);
    } catch (cause) {
      setActionError(messageFromCause(cause));
    } finally {
      setPending(null);
    }
  }

  async function editGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      threadId === null ||
      view.kind !== "current" ||
      objective.trim().length === 0
    ) {
      return;
    }
    setPending("edit");
    setActionError(null);
    try {
      const result = await rpc.call("edit", {
        threadId,
        goalId: view.goal.id,
        expectedRevision: view.goal.revision,
        objective,
      });
      setView({ kind: "current", goal: result.goal });
      setEditing(false);
      setObjective("");
    } catch (cause) {
      setActionError(messageFromCause(cause));
    } finally {
      setPending(null);
    }
  }

  async function mutateGoal(type: Exclude<GoalMutation, "edit">) {
    if (threadId === null || view.kind !== "current") return;
    setPending(type);
    setActionError(null);
    try {
      const result = await rpc.call(type, {
        threadId,
        goalId: view.goal.id,
        expectedRevision: view.goal.revision,
      });
      if (type === "cancel") {
        setView({ kind: "empty" });
      } else {
        setView({ kind: "current", goal: result.goal });
      }
    } catch (cause) {
      setActionError(messageFromCause(cause));
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

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
            disabled={busy || objective.trim().length === 0}
          >
            {pending === "start" ? "Starting" : "Start"}
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setStarting(false);
              setObjective("");
              setActionError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      {view.kind === "current" && editing ? (
        <form className="flex items-center gap-2" onSubmit={editGoal}>
          <label className="sr-only" htmlFor="goal-objective-edit">
            Edit Goal objective
          </label>
          <Input
            id="goal-objective-edit"
            autoFocus
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            className="h-8"
          />
          <Button
            size="sm"
            type="submit"
            disabled={busy || objective.trim().length === 0}
          >
            {pending === "edit" ? "Saving" : "Save"}
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setObjective("");
              setActionError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      {view.kind === "current" && !editing ? (
        <div className="flex min-h-8 items-center gap-3">
          <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-foreground">
            <span
              className={`size-2 rounded-full ${
                view.goal.state === "active"
                  ? "bg-success"
                  : "bg-muted-foreground"
              }`}
            />
            {goalStateLabel(view.goal.state)}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={view.goal.objective}
          >
            {view.goal.objective}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setObjective(view.goal.objective);
                setEditing(true);
                setActionError(null);
              }}
            >
              Edit Goal
            </Button>
            {view.goal.state === "active" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void mutateGoal("pause")}
              >
                {pending === "pause" ? "Pausing" : "Pause Goal"}
              </Button>
            ) : null}
            {view.goal.state === "paused" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void mutateGoal("resume")}
              >
                {pending === "resume" ? "Resuming" : "Resume Goal"}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void mutateGoal("cancel")}
            >
              {pending === "cancel" ? "Canceling" : "Cancel Goal"}
            </Button>
          </div>
        </div>
      ) : null}

      {actionError !== null ? (
        <div className="mt-1 flex items-center justify-between gap-3 text-destructive">
          <span className="truncate">{actionError}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
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
