# BB Goal plugin — System Definition

_**This file and the interactive atlas come from one architecture model.** Edit the data file, then rebuild both views._

_Question status: **3 open · 12 resolved**._

## One paragraph

Goal attaches one durable objective to an existing BB thread. Human controls enter through BB-native UI and CLI paths. The plugin stores the Goal against the thread, watches authoritative BB events, and sends an agent-only Continuation when the thread is idle and eligible. Guarded tools finish or block the exact Goal revision. Durable ledgers, structured recovery, and lifecycle reconciliation keep automatic work from outranking the user or replaying ambiguous sends.

## Decisions locked

| Axis | Decision | ADR |
|---|---|---|
| Ownership | Store Goal state against the BB thread so provider and model changes do not replace the objective. | [0001](../adr/0001-thread-owned-provider-independent-goals.md) |
| Controls | Use the composer, thread panel, and bb goal CLI. Do not add a /goal skill in v1. | [0002](../adr/0002-use-bb-native-goal-controls.md) |
| Storage | Wrap BB’s host-owned SQLite handle. Never open or close a second plugin connection. | [README](../../README.md) |
| Continuation delivery | Persist deterministic opportunities and delivery markers before sending an agent-only turn. | [server.ts](../../server.ts) |
| Authority | Queued user work, thread activity, Plan mode, interactions, archive, and deletion outrank automatic work. | [coordinator.ts](../../src/coordinator.ts) |
| Evidence | Classify failures and progress from structured BB events, not assistant claims. | [no-progress note](../no-progress-observation.md) |

## Cost model

## Deep dives

Native Codex Goal collision remains deferred under SDK 0.4.8. The plugin can observe native state, but the current host contract cannot close the activation read-to-send race without changes outside this repository.

## Reading order (the atlas chapters)

1. **A person and a thread** — The objective belongs to the BB thread, not to whichever provider happens to answer. _(adds H, T)_
2. **Starting and seeing a Goal** — BB-native controls keep Goal state visible without turning lifecycle commands into prompts. _(adds U, C)_
3. **One control path** — UI, CLI, events, and agent tools converge on one typed state machine. _(adds S, O)_
4. **Durable state and evidence** — SQLite stores decisions; BB’s timeline proves what happened outside the database. _(adds D, E)_
5. **A Continuation becomes durable** — An idle signal creates a durable opportunity before any automatic message is sent. _(adds Q, W)_
6. **User first, then delivery** — The worker sends only after a fresh authority check at the last possible moment. _(adds G, B, P)_
7. **Failures are not Blockage** — Provider errors and usage limits pause or defer work through a separate recovery path. _(adds F)_
8. **Stop an empty loop** — Three automatic turns without structured progress pause the Goal. _(adds N)_
9. **Finish, block, archive, or delete** — Exact revision guards close the Goal while lifecycle reconciliation keeps thread ownership honest. _(adds A, X, L)_
10. **The whole Goal system** — Choose a flow and inspect every packet, structure, decision, and open question.

## Structures

### People

#### H · Human

**In one line.** The person who owns the objective and every reversible or terminal control.

**What it does.** The human starts a Goal, changes its objective, pauses or resumes it, and may cancel or delete it. Automatic work must yield when the human has queued anything else.

**How it's built.** BB identifies human requests through structured request initiators, queued-message counts, prompt mode, and pending interaction state.

**Steps in execution.**

1. **Choose objective** — Write the outcome the thread must reach.
2. **Control** — Edit, pause, resume, cancel, or delete through BB.
3. **Review** — Inspect the active card and ordered Goal history.

### BB host

#### T · BB thread

**In one line.** The durable BB conversation that owns one unfinished Goal at a time.

**What it does.** The thread is the stable identity shared by the user, plugin, and whichever provider currently runs the agent.

**How it's built.** `threadId` keys Goal records, delivery checks, lifecycle ownership, event reads, and every mutation guard.

**Steps in execution.**

1. **Accept request** — BB records a structured request and turn boundary.
2. **Run provider** — The selected provider works in the existing thread.
3. **Become idle** — BB emits the state that can create a Continuation opportunity.

**Questions.**

- ~~**Q-T1** Should provider sessions own Goal state?~~ ✓ No. The BB thread owns it; providers are replaceable (ADR 0001, 2026-08-26).

#### U · Goal controls

**In one line.** The composer card and thread panel expose the active Goal and its history.

**What it does.** The compact composer card keeps the objective visible beside normal conversation. The panel shows prior Goals, terminal evidence, and lifecycle state.

**How it's built.** `app.tsx` mounts BB composer and panel slots, calls typed RPC methods, and refreshes on `goal.changed` realtime signals.

**Steps in execution.**

1. **Load status** — Read the unfinished Goal for the thread.
2. **Mutate** — Send an exact Goal ID and revision through RPC.
3. **Refresh** — React to the published Goal revision and redraw.

**Questions.**

- ~~**Q-U1** Should v1 add a /goal prompt skill?~~ ✓ No. BB-native controls avoid prompt parsing and native Codex command collisions (ADR 0002, 2026-08-26).

#### C · Goal CLI

**In one line.** The bb goal command gives humans and scripts the same lifecycle operations as the UI.

**What it does.** Commands start, inspect, edit, pause, resume, cancel, browse, show, and delete Goals. Reads support JSON, and guarded mutations never overwrite a newer revision.

**How it's built.** `server.ts` registers the CLI, parses thread context and objective files, then calls the same coordinator path used by RPC.

**Steps in execution.**

1. **Parse** — Resolve the thread, arguments, JSON mode, and optional file.
2. **Dispatch** — Call the shared Goal command.
3. **Render** — Print a human view or stable JSON DTO.

#### E · Structured timeline

**In one line.** Authoritative BB events describe request, turn, item, failure, and lifecycle boundaries.

**What it does.** The plugin reads structured rows to correlate automatic requests with accepted turns, results, errors, user activity, archive, and deletion.

**How it's built.** The BB SDK gateway reads bounded timeline windows. `src/progress.ts` and `src/failure.ts` require ordered IDs, scopes, sequences, and request or turn correlation.

**Steps in execution.**

1. **Read window** — Fetch the bounded authoritative rows for one thread.
2. **Correlate** — Match request, accepted turn, scoped items, and terminal event.
3. **Classify** — Return a structured observation without parsing assistant claims.

**Questions.**

- ~~**Q-E1** May assistant prose claim that progress or a usage limit occurred?~~ ✓ No. The plugin uses structured timeline evidence; prose is not authority (2026-08-26).

#### B · BB thread gateway

**In one line.** The gateway reads authoritative thread state and sends agent-only Continuations.

**What it does.** This adapter is the plugin’s only route to thread snapshots, timeline observations, lifecycle ownership, delivery reconciliation, and automatic message sending.

**How it's built.** `GoalThreadGatewayAdapter` wraps documented BB SDK calls. Delivery uses a deterministic marker and `visibility: "agent-only"`.

**Steps in execution.**

1. **Read** — Fetch current thread and runtime state.
2. **Reconcile** — Search structured timeline rows for an existing delivery marker.
3. **Send** — Ask BB to start one agent-only automatic turn.

**Questions.**

- **Q-B1** How can native Codex Goal activation and plugin Goal activation be made atomic? → _SDK host-contract work; SDK 0.4.8 cannot close the read-to-send race_

#### P · Provider agent

**In one line.** Pi, Claude Code, Codex, or ACP pursues the same BB-owned Goal.

**What it does.** The provider receives Goal instructions and selected plugin tools at the BB agent boundary. Provider-native Goal implementations are not used as storage or lifecycle authority.

**How it's built.** `bb.agents.configure` contributes the exact Goal ID, revision, objective, authority rules, and tool schemas when an active Goal exists.

**Steps in execution.**

1. **Load context** — BB injects the active objective and exact revision guard.
2. **Work** — The provider uses ordinary coding and web tools.
3. **Report** — The provider calls a guarded terminal tool only when its criteria are met.

### Goal plugin

#### S · Plugin server

**In one line.** The registration layer connects BB APIs to one managed Goal runtime.

**What it does.** This layer owns plugin startup and disposal. It registers RPC, CLI commands, agent tools, event handlers, realtime signals, and the continuation service.

**How it's built.** `server.ts` creates one `ManagedRuntime`, adapts BB’s database and thread APIs, and disposes all fibers through `bb.onDispose`.

**Steps in execution.**

1. **Register** — Expose BB UI, CLI, RPC, tools, events, and service hooks.
2. **Adapt** — Translate BB SDK values into domain commands and snapshots.
3. **Publish** — Emit goal.changed after successful mutations.

**Questions.**

- **Q-S1** How should Start and Resume wake an already-idle thread exactly once?

#### O · Goal coordinator

**In one line.** The typed state machine decides which Goal transition or automatic action is valid.

**What it does.** Every lifecycle command, eligibility decision, recovery action, and terminal report passes through one public coordinator. It returns typed domain failures instead of guessing at UI or provider state.

**How it's built.** `src/coordinator.ts` is an Effect service over `GoalRepository` and `GoalThreadGatewayAdapter`. `src/runtime.ts` runs it in one managed runtime.

**Steps in execution.**

1. **Decode command** — Accept one typed Goal command.
2. **Read authority** — Check Goal revision and authoritative thread state.
3. **Transition** — Execute one repository transaction or gateway action.
4. **Return** — Produce a plain DTO or typed failure.

**Questions.**

- ~~**Q-O1** Why use Effect only inside the coordinator boundary?~~ ✓ It gives typed services, cancellation, retries, and managed disposal without forcing React, CLI parsing, or BB registration into Effect (2026-08-26).

#### D · Goal repository

**In one line.** The repository makes Goal state, claims, evidence, and cleanup durable and atomic.

**What it does.** SQLite keeps ordered Goal history and the ledgers required to survive plugin reloads, BB restarts, ambiguous sends, failures, and lifecycle races.

**How it's built.** `src/repository.ts` runs migrations on BB’s `better-sqlite3` handle. Transactions enforce one unfinished Goal per thread and compare expected revisions before changes.

**Steps in execution.**

1. **Migrate** — Create or extend plugin-owned tables on the host handle.
2. **Read** — Decode rows into validated Goal DTOs and durable work records.
3. **Transact** — Guard revisions, claim work, and record outcomes atomically.
4. **Clean** — Delete every plugin-owned row family when the thread is deleted.

**Questions.**

- ~~**Q-D1** May the plugin open its own SQLite connection?~~ ✓ No. It wraps BB’s host-owned handle and never closes it (feasibility decision, 2026-08-26).

#### A · Agent Goal context

**In one line.** A bounded synchronous snapshot selects Goal instructions and terminal tools for the provider.

**What it does.** Only an active Goal contributes context. Paused and finished Goals expose no Goal tools or instructions.

**How it's built.** `makeCurrentGoalSnapshotReader` performs one bounded direct SQLite read inside `bb.agents.configure`. Parameters pin the active Goal ID and revision.

**Steps in execution.**

1. **Snapshot** — Read the unfinished Goal synchronously from the host database.
2. **Select** — Return no tools unless the Goal is active.
3. **Pin** — Constrain both tool schemas to the exact ID and revision.

**Questions.**

- **Q-A1** How should a Goal started after a provider runtime loads refresh its selected tool catalog?

#### X · Terminal Goal tools

**In one line.** Namespaced tools complete or qualify Blockage against the exact active Goal revision.

**What it does.** Completion requires a concrete summary and verification evidence. Blockage requires the same normalized external action across reports one, two, and three.

**How it's built.** `bb_goal_complete` and `bb_goal_blocked` use plugin-owned names to avoid BB’s reserved Goal tool. The coordinator and repository reject stale, replaced, or cross-thread Goals.

**Steps in execution.**

1. **Validate input** — Require exact Goal ID, revision, and terminal evidence.
2. **Guard** — Re-read the active thread Goal in one transaction.
3. **Transition** — Complete, qualify, or block without overwriting newer state.
4. **Publish** — Return the DTO and emit goal.changed.

**Questions.**

- ~~**Q-X1** Why are the tools namespaced?~~ ✓ The unnamespaced goal_complete collided with BB’s reserved session tool. bb_goal_complete passed a live Pi adapter smoke (2026-08-26).

### Automatic continuation

#### Q · Continuation ledger

**In one line.** A durable ledger gives every automatic opportunity, claim, send, and outcome an identity.

**What it does.** The ledger separates the decision to continue from delivery. That makes crash recovery and ambiguous-send reconciliation possible without relying on an in-memory queue.

**How it's built.** `goal_continuations` stores the Goal revision, opportunity key, attempt, state, lease, delivery marker, outcome, and progress evidence. Unique keys reject the same opportunity twice.

**Steps in execution.**

1. **Enqueue** — Insert one deterministic opportunity for the active Goal revision.
2. **Claim** — Lease one pending record to a worker.
3. **Mark sending** — Persist the delivery marker before crossing the BB send boundary.
4. **Resolve** — Record sent, released, or expired after reconciliation.

**Questions.**

- **Q-Q1** Which durable activation key should represent the first turn after Start or Resume? → _Activation and duplicate-delivery investigation_

#### W · Continuation worker

**In one line.** One cancellation-aware background service recovers and delivers eligible automatic work.

**What it does.** The worker reconciles thread ownership, retries missed idle events, recovers usage windows and ambiguous claims, assesses settled turns, and processes one durable Continuation at a time.

**How it's built.** `bb.background.service("continuations")` loops with bounded backoff and an abort signal. In-memory wake keys reduce latency but never replace SQLite state.

**Steps in execution.**

1. **Recover** — Reconcile ownership, idle events, usage windows, claims, and unassessed sends.
2. **Claim** — Lease one pending Continuation.
3. **Check** — Ask the coordinator for current Goal and thread eligibility.
4. **Deliver** — Send or release the claim, then wake for remaining work.

**Questions.**

- **Q-W1** Can plugin reload or repeated idle events create multiple distinct opportunities for one idle boundary?

#### G · Eligibility gate

**In one line.** The final gate yields to authoritative user activity and non-idle thread state.

**What it does.** Automatic work stops before delivery when the thread is archived, deleted, queued, active, in Plan mode, waiting on interaction, or running on a non-idle runtime.

**How it's built.** `goalContinuationEligibility` evaluates a fresh `GoalThreadSnapshot`. The send path rechecks immediately before crossing the gateway.

**Steps in execution.**

1. **Read snapshot** — Fetch current thread, runtime, queue, Plan mode, interaction, and ownership state.
2. **Evaluate** — Return eligible or one concrete reason code.
3. **Recheck** — Repeat at the final send boundary.

**Questions.**

- ~~**Q-G1** What outranks a Continuation?~~ ✓ Queued user messages, active or non-idle runtime, Plan mode, pending interactions, archive, and deletion (2026-08-26).

### Recovery and safety

#### F · Failure recovery

**In one line.** Structured terminal errors pause or defer automatic work without pretending the Goal is blocked.

**What it does.** Ordinary failures pause the Goal. Known subscription resets can recover after their full window passes. Unknown resets and credit or spend controls require manual resumption.

**How it's built.** `src/failure.ts` correlates event identity, scope, sequence, turn, blocked state, and every trustworthy reset window. The repository deduplicates durable failure facts.

**Steps in execution.**

1. **Observe** — Read terminal error and blocked-state evidence.
2. **Classify** — Separate ordinary failure, known reset, and manual-only usage limits.
3. **Persist** — Pause or record the usage window once.
4. **Recover** — After reset, re-run full Goal and eligibility checks before enqueueing.

**Questions.**

- ~~**Q-F1** May an unknown usage reset resume automatically?~~ ✓ No. Only a trustworthy known subscription reset can recover automatically (2026-08-26).

#### N · No-progress guard

**In one line.** Three automatic turns without structured progress pause the Goal atomically.

**What it does.** The guard protects the thread from repeating the same automatic response forever. It compares authoritative turn activity and a normalized fingerprint of the final structured agent message.

**How it's built.** `src/progress.ts` correlates delivery marker, request, accepted turn, scoped items, and completion. `src/repository.ts` records evidence and pauses count three in one transaction.

**Steps in execution.**

1. **Correlate** — Prove the settled turn belongs to one sent Continuation.
2. **Map signals** — Detect tools, file changes, external actions, interactions, and result fingerprint.
3. **Count** — Reset on progress or increment the durable streak.
4. **Pause** — At three, pause the same Goal revision and release pending work.

**Questions.**

- ~~**Q-N1** What counts as no progress?~~ ✓ No qualifying structured signal and no changed normalized assistant result across the correlated automatic turn (2026-08-26).

#### L · Lifecycle reconciler

**In one line.** Archive and deletion events reconcile thread ownership until authoritative cleanup succeeds.

**What it does.** Archive pauses Goal work. Unarchive does nothing automatically. Delete removes every plugin-owned row family. Forked threads do not inherit Goal state.

**How it's built.** `server.ts` queues thread-scoped ownership reconciliation with bounded cancellation-aware backoff. Startup scans owned thread IDs so a missed event does not strand state.

**Steps in execution.**

1. **Queue** — Record the thread as needing ownership reconciliation.
2. **Read owner** — Check authoritative existence, archive, and deletion state.
3. **Apply** — Pause archived work or delete all plugin-owned state.
4. **Retry** — Keep the thread queued until reconciliation succeeds or disposal cancels it.

**Questions.**

- ~~**Q-L1** Should unarchive resume a Goal automatically?~~ ✓ No. Unarchive is inert; the user must resume deliberately (2026-08-26).

## Flows (representative packets)

Payload shapes are what the design implies, not measured traffic.

### Start and inspect a Goal

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | H → U | objective | `{"objective":"Publish the Goal plugin"}` |
| 2 | U → S | rpc.start | `{"threadId":"thr_…","objective":"Publish the Goal plugin"}` |
| 3 | S → O | start command | `{"type":"start","threadId":"thr_…"}` |
| 4 | O → D | atomic insert | `{"state":"active","revision":1}` |
| 5 | D → S | Goal DTO | `{"goalId":"goal_…","state":"active","revision":1}` |
| 6 | S → U | goal.changed | `{"threadId":"thr_…","revision":1}` |

### Deliver one Continuation

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | T → E | thread.idle | `{"threadId":"thr_…","seq":410}` |
| 2 | E → S | idle event | `{"eventId":"evt_…","seq":410}` |
| 3 | S → O | enqueue idle | `{"opportunityKey":"idle:evt_…"}` |
| 4 | O → Q | pending record | `{"goalRevision":3,"state":"pending"}` |
| 5 | Q → W | leased claim | `{"attempt":1,"state":"claimed"}` |
| 6 | W → G | fresh snapshot | `{"queued":0,"runtime":"idle"}` |
| 7 | G → B | eligible send | `{"marker":"bb-goal-continuation:goal_…"}` |
| 8 | B → T | agent-only request | `{"initiator":"system","target":"auto"}` |
| 9 | T → P | Goal turn | `{"provider":"replaceable"}` |

### Complete the exact Goal

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | D → A | active snapshot | `{"goalId":"goal_…","revision":3}` |
| 2 | A → P | instructions + tools | `{"tools":["bb_goal_complete","bb_goal_blocked"]}` |
| 3 | P → X | bb_goal_complete | `{"goalId":"goal_…","expectedRevision":3}` |
| 4 | X → O | complete command | `{"summary":"Released and verified"}` |
| 5 | O → D | guarded transition | `{"from":"active","to":"completed","revision":4}` |
| 6 | D → S | completed DTO | `{"state":"completed","revision":4}` |
| 7 | S → U | goal.changed | `{"state":"completed"}` |

### Recover from a provider limit

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | T → E | terminal failure | `{"code":"rate_limit","turnId":"turn_…"}` |
| 2 | E → F | structured facts | `{"resetAt":"2026-08-27T00:00:00Z"}` |
| 3 | F → O | pause or recover | `{"kind":"subscription","reliableReset":true}` |
| 4 | O → D | durable state | `{"state":"paused","reason":"usage-limit"}` |
| 5 | D → W | reset becomes due | `{"goalRevision":3}` |
| 6 | W → G | full eligibility recheck | `{"nowAfterReset":true}` |

### Reconcile archive or deletion

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | T → E | lifecycle event | `{"archived":true,"deleted":false}` |
| 2 | E → L | ownership pending | `{"threadId":"thr_…"}` |
| 3 | L → B | authoritative read | `{"read":"ownership"}` |
| 4 | B → L | thread ownership | `{"exists":true,"archived":true}` |
| 5 | L → O | pause archive work | `{"reason":"thread-archived"}` |
| 6 | O → D | atomic cleanup | `{"releasePending":true}` |

## Questions — index

Reference by ID. ✓ resolved (with date) · otherwise open.

- ~~**Q-T1**~~ (T) ✓ No. The BB thread owns it; providers are replaceable (ADR 0001, 2026-08-26).
- ~~**Q-U1**~~ (U) ✓ No. BB-native controls avoid prompt parsing and native Codex command collisions (ADR 0002, 2026-08-26).
- ~~**Q-E1**~~ (E) ✓ No. The plugin uses structured timeline evidence; prose is not authority (2026-08-26).
- **Q-B1** (B) How can native Codex Goal activation and plugin Goal activation be made atomic?
- **Q-S1** (S) How should Start and Resume wake an already-idle thread exactly once?
- ~~**Q-O1**~~ (O) ✓ It gives typed services, cancellation, retries, and managed disposal without forcing React, CLI parsing, or BB registration into Effect (2026-08-26).
- ~~**Q-D1**~~ (D) ✓ No. It wraps BB’s host-owned handle and never closes it (feasibility decision, 2026-08-26).
- **Q-A1** (A) How should a Goal started after a provider runtime loads refresh its selected tool catalog?
- ~~**Q-X1**~~ (X) ✓ The unnamespaced goal_complete collided with BB’s reserved session tool. bb_goal_complete passed a live Pi adapter smoke (2026-08-26).
- **Q-Q1** (Q) Which durable activation key should represent the first turn after Start or Resume?
- **Q-W1** (W) Can plugin reload or repeated idle events create multiple distinct opportunities for one idle boundary?
- ~~**Q-G1**~~ (G) ✓ Queued user messages, active or non-idle runtime, Plan mode, pending interactions, archive, and deletion (2026-08-26).
- ~~**Q-F1**~~ (F) ✓ No. Only a trustworthy known subscription reset can recover automatically (2026-08-26).
- ~~**Q-N1**~~ (N) ✓ No qualifying structured signal and no changed normalized assistant result across the correlated automatic turn (2026-08-26).
- ~~**Q-L1**~~ (L) ✓ No. Unarchive is inert; the user must resume deliberately (2026-08-26).

## What the platform gives vs what we own

**Platform gives:** BB supplies threads, provider sessions, lifecycle and timeline events, plugin RPC and CLI registration, realtime signals, agent configuration, a host-owned SQLite handle, and agent-only message delivery.

**We own:** The plugin owns Goal state, revision guards, history, Continuation identities and claims, eligibility checks, recovery policy, no-progress evidence, terminal tools, and thread-lifecycle cleanup.

## Planned filesystem

```
app.tsx                         BB-native composer card and history panel
server.ts                      Plugin registration, adapters, events, worker, RPC, CLI, tools
src/domain.ts                  Goal commands, DTOs, schemas, and typed errors
src/coordinator.ts             Lifecycle rules and continuation eligibility
src/repository.ts              SQLite migrations and atomic durable transitions
src/runtime.ts                 Managed Effect runtime boundary
src/failure.ts                 Structured failure and usage-limit classification
src/progress.ts                Structured no-progress observation
src/history-cursor.ts          Opaque Goal-history pagination
server.test.ts                 Fake-host and adapter coverage
src/coordinator.test.ts        Coordinator and real-SQLite behavior
app.test.tsx                   Frontend harness coverage
```

## How this file is maintained

Generated from `docs/goal/atlas/data.mjs` by `node docs/goal/atlas/build.mjs`, which also builds the interactive atlas (`atlas.html`, published at ./atlas.html). Edit the data file, rebuild, republish — never edit this file by hand.
