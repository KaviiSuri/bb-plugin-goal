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
  useBbNavigate,
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
  readonly completionSummary: string | null;
  readonly verificationEvidence: string | null;
  readonly blockageExternalAction: string | null;
  readonly blockageEvidence: string | null;
  readonly blockageRepeatedTurns: number | null;
  readonly pauseReasonCode:
    | "manual"
    | "failure"
    | "usage-limit"
    | "no-progress"
    | null;
  readonly pauseReason: string | null;
  readonly usageLimitKind:
    | "subscription-window"
    | "credits"
    | "spend-control"
    | "unknown"
    | null;
  readonly usageResetAt: string | null;
  readonly noProgressConsecutiveCount: number;
  readonly noProgressLastContinuationId: string | null;
  readonly noProgressAssistantResultFingerprint: string | null;
  readonly noProgressEvidence: {
    readonly turnId: string;
    readonly terminalSeq: number;
    readonly signals: readonly string[];
    readonly assessment: "progress" | "no-progress";
  } | null;
}

type ViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "current"; readonly goal: GoalView }
  | { readonly kind: "error"; readonly message: string };

type HistoryViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly goals: readonly GoalView[];
      readonly nextCursor: string | null;
    };

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
      return "Waiting for usage reset";
    case "completed":
      return "Completed Goal";
    case "blocked":
      return "Blocked Goal";
    case "canceled":
      return "Canceled Goal";
  }
}

export function GoalHistoryPanel({ threadId }: { readonly threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  const [view, setView] = useState<HistoryViewState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirming, setConfirming] = useState<GoalView | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await rpc.call("history", {
        threadId,
        limit: 20,
        cursor: null,
      });
      setView({ kind: "ready", ...page });
      setConfirming(null);
      setActionError(null);
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

  async function loadMore() {
    if (view.kind !== "ready" || view.nextCursor === null) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const page = await rpc.call("history", {
        threadId,
        limit: 20,
        cursor: view.nextCursor,
      });
      setView({
        kind: "ready",
        goals: [...view.goals, ...page.goals],
        nextCursor: page.nextCursor,
      });
    } catch (cause) {
      setActionError(messageFromCause(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  async function deleteGoal(goal: GoalView) {
    setDeletingId(goal.id);
    setActionError(null);
    try {
      await rpc.call("delete", {
        threadId,
        goalId: goal.id,
        expectedRevision: goal.revision,
      });
      await load();
    } catch (cause) {
      setActionError(messageFromCause(cause));
    } finally {
      setDeletingId(null);
    }
  }

  if (view.kind === "loading") {
    return (
      <div className="text-sm text-muted-foreground" role="status">
        Loading Goal history
      </div>
    );
  }

  if (view.kind === "error") {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-destructive">{view.message}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <section aria-label="Goal history" className="space-y-4 text-sm">
      <header>
        <h2 className="font-medium text-foreground">Goal history</h2>
        <p className="mt-1 text-muted-foreground">
          Newest first. Current and finished objectives stay with this thread.
        </p>
      </header>

      {view.goals.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-muted-foreground">
          No Goals have been recorded for this thread.
        </div>
      ) : (
        <ol className="space-y-3">
          {view.goals.map((goal) => {
            const deleting = deletingId === goal.id;
            const isConfirming = confirming?.id === goal.id;
            return (
              <li
                key={goal.id}
                className="rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {goalStateLabel(goal.state)}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {goal.finishedAt === null ? "Current" : "Historical"}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-foreground">
                      {goal.objective}
                    </p>
                    {goal.completionSummary !== null ? (
                      <div className="mt-3 rounded-md bg-muted/50 p-2 text-sm">
                        <p className="font-medium text-foreground">
                          Completion summary
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {goal.completionSummary}
                        </p>
                        <p className="mt-2 font-medium text-foreground">
                          Verification evidence
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {goal.verificationEvidence}
                        </p>
                      </div>
                    ) : null}
                    {goal.pauseReason !== null ? (
                      <div className="mt-3 rounded-md bg-muted/50 p-2 text-sm">
                        <p className="font-medium text-foreground">
                          Why Goal work paused
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {goal.pauseReason}
                        </p>
                        {goal.usageLimitKind !== null ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Usage limit: {goal.usageLimitKind}
                            {goal.usageResetAt === null
                              ? " (manual resume required)"
                              : ` · resets ${goal.usageResetAt}`}
                          </p>
                        ) : null}
                        {goal.noProgressEvidence !== null ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            No-progress count: {goal.noProgressConsecutiveCount}
                            {` · turn ${goal.noProgressEvidence.turnId} · terminal sequence ${goal.noProgressEvidence.terminalSeq}`}
                            {goal.noProgressEvidence.signals.length === 0
                              ? " · no qualifying signals"
                              : ` · signals ${goal.noProgressEvidence.signals.join(", ")}`}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {goal.blockageExternalAction !== null ? (
                      <div className="mt-3 rounded-md bg-muted/50 p-2 text-sm">
                        <p className="font-medium text-foreground">
                          External action required
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {goal.blockageExternalAction}
                        </p>
                        <p className="mt-2 font-medium text-foreground">
                          Blockage evidence
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {goal.blockageEvidence}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Same blocker reported for {goal.blockageRepeatedTurns} Goal turns
                        </p>
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <code>{goal.id}</code>
                      <span>Revision {goal.revision}</span>
                      <time dateTime={goal.createdAt}>{goal.createdAt}</time>
                    </div>
                  </div>
                  {!isConfirming ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={deletingId !== null}
                      onClick={() => {
                        setConfirming(goal);
                        setActionError(null);
                      }}
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>

                {isConfirming ? (
                  <div
                    className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"
                    role="alert"
                  >
                    <span className="text-destructive">
                      Delete this Goal permanently?
                    </span>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={deleting}
                        onClick={() => setConfirming(null)}
                      >
                        Keep Goal
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={deleting}
                        onClick={() => void deleteGoal(goal)}
                      >
                        {deleting ? "Deleting" : "Confirm delete"}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {view.nextCursor !== null ? (
        <Button
          size="sm"
          variant="outline"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading" : "Load older Goals"}
        </Button>
      ) : null}

      {actionError !== null ? (
        <div className="flex items-center justify-between gap-3 text-destructive">
          <span>{actionError}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function GoalComposerRow() {
  const { threadId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
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

  function openHistory() {
    const opened = navigate.openThreadPanel({
      actionId: "history",
      title: "Goal history",
    });
    if (!opened) {
      setActionError("Goal history is unavailable in this view.");
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
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" onClick={openHistory}>
              History
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setStarting(true)}
            >
              Start Goal
            </Button>
          </div>
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
            title={view.goal.pauseReason ?? view.goal.objective}
          >
            {view.goal.objective}
            {view.goal.pauseReason === null ? "" : ` · ${view.goal.pauseReason}`}
          </span>
          {view.goal.noProgressConsecutiveCount > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              No-progress {view.goal.noProgressConsecutiveCount}/3
            </span>
          ) : null}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={openHistory}
            >
              History
            </Button>
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
            {view.goal.state === "active" || view.goal.state === "waiting" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void mutateGoal("pause")}
              >
                {pending === "pause" ? "Pausing" : "Pause Goal"}
              </Button>
            ) : null}
            {view.goal.state === "paused" || view.goal.state === "waiting" ? (
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
  app.slots.threadPanelAction({
    id: "history",
    title: "Goal history",
    icon: "History",
    component: GoalHistoryPanel,
  });

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
