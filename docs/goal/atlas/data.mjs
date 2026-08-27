// Single source of truth for the Goal system atlas.
// Build: node docs/goal/atlas/build.mjs

export const META = {
  title: 'BB Goal plugin',
  artifactUrl: './atlas.html',
  sourcePath: 'docs/goal/atlas/data.mjs',
  buildCmd: 'node docs/goal/atlas/build.mjs',
  stats: [
    { k: 'System', v: 'goal · v0.1.1' },
    { k: 'Runtime roles', v: 'BB host · plugin · provider' },
  ],
  intro: `_**This file and the interactive atlas come from one architecture model.** Edit the data file, then rebuild both views._`,
  onePara: `Goal attaches one durable objective to an existing BB thread. Human controls enter through BB-native UI and CLI paths. The plugin stores the Goal against the thread, watches authoritative BB events, and sends an agent-only Continuation when the thread is idle and eligible. Guarded tools finish or block the exact Goal revision. Durable ledgers, structured recovery, and lifecycle reconciliation keep automatic work from outranking the user or replaying ambiguous sends.`,
  costModel: [],
  deepDive: `Native Codex Goal collision remains deferred under SDK 0.4.8. The plugin can observe native state, but the current host contract cannot close the activation read-to-send race without changes outside this repository.`,
  platformGives: `BB supplies threads, provider sessions, lifecycle and timeline events, plugin RPC and CLI registration, realtime signals, agent configuration, a host-owned SQLite handle, and agent-only message delivery.`,
  weOwn: `The plugin owns Goal state, revision guards, history, Continuation identities and claims, eligibility checks, recovery policy, no-progress evidence, terminal tools, and thread-lifecycle cleanup.`,
  filesystem: `app.tsx                         BB-native composer card and history panel
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
app.test.tsx                   Frontend harness coverage`,
};

export const DECISIONS = [
  {
    axis: 'Ownership',
    decision: 'Store Goal state against the BB thread so provider and model changes do not replace the objective.',
    adr: '[0001](../adr/0001-thread-owned-provider-independent-goals.md)',
  },
  {
    axis: 'Controls',
    decision: 'Use the composer, thread panel, and bb goal CLI. Do not add a /goal skill in v1.',
    adr: '[0002](../adr/0002-use-bb-native-goal-controls.md)',
  },
  {
    axis: 'Storage',
    decision: 'Wrap BB’s host-owned SQLite handle. Never open or close a second plugin connection.',
    adr: '[README](../../README.md)',
  },
  {
    axis: 'Continuation delivery',
    decision: 'Persist deterministic opportunities and delivery markers before sending an agent-only turn.',
    adr: '[server.ts](../../server.ts)',
  },
  {
    axis: 'Authority',
    decision: 'Queued user work, thread activity, Plan mode, interactions, archive, and deletion outrank automatic work.',
    adr: '[coordinator.ts](../../src/coordinator.ts)',
  },
  {
    axis: 'Evidence',
    decision: 'Classify failures and progress from structured BB events, not assistant claims.',
    adr: '[no-progress note](../no-progress-observation.md)',
  },
];

export const GROUPS = [
  { id: 'people', title: 'People' },
  { id: 'bb', title: 'BB host' },
  { id: 'plugin', title: 'Goal plugin' },
  { id: 'continuation', title: 'Automatic continuation' },
  { id: 'safety', title: 'Recovery and safety' },
];

export const NODES = [
  {
    id: 'H', code: 'H', name: 'Human', short: 'HUMAN', group: 'people',
    gx: 1, gy: 8, w: 2, d: 2, h: 38, kind: 'screen',
    one: 'The person who owns the objective and every reversible or terminal control.',
    what: 'The human starts a Goal, changes its objective, pauses or resumes it, and may cancel or delete it. Automatic work must yield when the human has queued anything else.',
    how: 'BB identifies human requests through structured request initiators, queued-message counts, prompt mode, and pending interaction state.',
    steps: [['Choose objective', 'Write the outcome the thread must reach.'], ['Control', 'Edit, pause, resume, cancel, or delete through BB.'], ['Review', 'Inspect the active card and ordered Goal history.']],
    cond: [],
  },
  {
    id: 'T', code: 'T', name: 'BB thread', short: 'BB THREAD', group: 'bb',
    gx: 4, gy: 6, w: 3, d: 3, h: 34, kind: 'slab',
    one: 'The durable BB conversation that owns one unfinished Goal at a time.',
    what: 'The thread is the stable identity shared by the user, plugin, and whichever provider currently runs the agent.',
    how: '<code>threadId</code> keys Goal records, delivery checks, lifecycle ownership, event reads, and every mutation guard.',
    steps: [['Accept request', 'BB records a structured request and turn boundary.'], ['Run provider', 'The selected provider works in the existing thread.'], ['Become idle', 'BB emits the state that can create a Continuation opportunity.']],
    cond: [{ q: 'Should provider sessions own Goal state?', r: 'No. The BB thread owns it; providers are replaceable (ADR 0001, 2026-08-26).' }],
  },
  {
    id: 'U', code: 'U', name: 'Goal controls', short: 'GOAL UI', group: 'bb',
    gx: 0, gy: 4, w: 3, d: 2, h: 42, kind: 'screen',
    one: 'The composer card and thread panel expose the active Goal and its history.',
    what: 'The compact composer card keeps the objective visible beside normal conversation. The panel shows prior Goals, terminal evidence, and lifecycle state.',
    how: '<code>app.tsx</code> mounts BB composer and panel slots, calls typed RPC methods, and refreshes on <code>goal.changed</code> realtime signals.',
    steps: [['Load status', 'Read the unfinished Goal for the thread.'], ['Mutate', 'Send an exact Goal ID and revision through RPC.'], ['Refresh', 'React to the published Goal revision and redraw.']],
    cond: [{ q: 'Should v1 add a /goal prompt skill?', r: 'No. BB-native controls avoid prompt parsing and native Codex command collisions (ADR 0002, 2026-08-26).' }],
  },
  {
    id: 'C', code: 'C', name: 'Goal CLI', short: 'BB GOAL CLI', group: 'bb',
    gx: 0, gy: 11, w: 3, d: 2, h: 36, kind: 'screen',
    one: 'The bb goal command gives humans and scripts the same lifecycle operations as the UI.',
    what: 'Commands start, inspect, edit, pause, resume, cancel, browse, show, and delete Goals. Reads support JSON, and guarded mutations never overwrite a newer revision.',
    how: '<code>server.ts</code> registers the CLI, parses thread context and objective files, then calls the same coordinator path used by RPC.',
    steps: [['Parse', 'Resolve the thread, arguments, JSON mode, and optional file.'], ['Dispatch', 'Call the shared Goal command.'], ['Render', 'Print a human view or stable JSON DTO.']],
    cond: [],
  },
  {
    id: 'S', code: 'S', name: 'Plugin server', short: 'PLUGIN SERVER', group: 'plugin',
    gx: 7, gy: 6, w: 3, d: 3, h: 34, kind: 'slab',
    one: 'The registration layer connects BB APIs to one managed Goal runtime.',
    what: 'This layer owns plugin startup and disposal. It registers RPC, CLI commands, agent tools, event handlers, realtime signals, and the continuation service.',
    how: '<code>server.ts</code> creates one <code>ManagedRuntime</code>, adapts BB’s database and thread APIs, and disposes all fibers through <code>bb.onDispose</code>.',
    steps: [['Register', 'Expose BB UI, CLI, RPC, tools, events, and service hooks.'], ['Adapt', 'Translate BB SDK values into domain commands and snapshots.'], ['Publish', 'Emit goal.changed after successful mutations.']],
    cond: ['How should Start and Resume wake an already-idle thread exactly once?'],
  },
  {
    id: 'O', code: 'O', name: 'Goal coordinator', short: 'COORDINATOR', group: 'plugin',
    gx: 10, gy: 5, w: 3, d: 3, h: 72, kind: 'tall',
    one: 'The typed state machine decides which Goal transition or automatic action is valid.',
    what: 'Every lifecycle command, eligibility decision, recovery action, and terminal report passes through one public coordinator. It returns typed domain failures instead of guessing at UI or provider state.',
    how: '<code>src/coordinator.ts</code> is an Effect service over <code>GoalRepository</code> and <code>GoalThreadGatewayAdapter</code>. <code>src/runtime.ts</code> runs it in one managed runtime.',
    steps: [['Decode command', 'Accept one typed Goal command.'], ['Read authority', 'Check Goal revision and authoritative thread state.'], ['Transition', 'Execute one repository transaction or gateway action.'], ['Return', 'Produce a plain DTO or typed failure.']],
    cond: [{ q: 'Why use Effect only inside the coordinator boundary?', r: 'It gives typed services, cancellation, retries, and managed disposal without forcing React, CLI parsing, or BB registration into Effect (2026-08-26).' }],
  },
  {
    id: 'D', code: 'D', name: 'Goal repository', short: 'SQLITE STORE', group: 'plugin',
    gx: 13, gy: 8, w: 3, d: 3, h: 30, kind: 'store',
    one: 'The repository makes Goal state, claims, evidence, and cleanup durable and atomic.',
    what: 'SQLite keeps ordered Goal history and the ledgers required to survive plugin reloads, BB restarts, ambiguous sends, failures, and lifecycle races.',
    how: '<code>src/repository.ts</code> runs migrations on BB’s <code>better-sqlite3</code> handle. Transactions enforce one unfinished Goal per thread and compare expected revisions before changes.',
    steps: [['Migrate', 'Create or extend plugin-owned tables on the host handle.'], ['Read', 'Decode rows into validated Goal DTOs and durable work records.'], ['Transact', 'Guard revisions, claim work, and record outcomes atomically.'], ['Clean', 'Delete every plugin-owned row family when the thread is deleted.']],
    cond: [{ q: 'May the plugin open its own SQLite connection?', r: 'No. It wraps BB’s host-owned handle and never closes it (feasibility decision, 2026-08-26).' }],
  },
  {
    id: 'E', code: 'E', name: 'Structured timeline', short: 'EVENT LOG', group: 'bb',
    gx: 6, gy: 11, w: 3, d: 3, h: 28, kind: 'store',
    one: 'Authoritative BB events describe request, turn, item, failure, and lifecycle boundaries.',
    what: 'The plugin reads structured rows to correlate automatic requests with accepted turns, results, errors, user activity, archive, and deletion.',
    how: 'The BB SDK gateway reads bounded timeline windows. <code>src/progress.ts</code> and <code>src/failure.ts</code> require ordered IDs, scopes, sequences, and request or turn correlation.',
    steps: [['Read window', 'Fetch the bounded authoritative rows for one thread.'], ['Correlate', 'Match request, accepted turn, scoped items, and terminal event.'], ['Classify', 'Return a structured observation without parsing assistant claims.']],
    cond: [{ q: 'May assistant prose claim that progress or a usage limit occurred?', r: 'No. The plugin uses structured timeline evidence; prose is not authority (2026-08-26).' }],
  },
  {
    id: 'Q', code: 'Q', name: 'Continuation ledger', short: 'CONT. LEDGER', group: 'continuation',
    gx: 10, gy: 11, w: 3, d: 3, h: 28, kind: 'store',
    one: 'A durable ledger gives every automatic opportunity, claim, send, and outcome an identity.',
    what: 'The ledger separates the decision to continue from delivery. That makes crash recovery and ambiguous-send reconciliation possible without relying on an in-memory queue.',
    how: '<code>goal_continuations</code> stores the Goal revision, opportunity key, attempt, state, lease, delivery marker, outcome, and progress evidence. Unique keys reject the same opportunity twice.',
    steps: [['Enqueue', 'Insert one deterministic opportunity for the active Goal revision.'], ['Claim', 'Lease one pending record to a worker.'], ['Mark sending', 'Persist the delivery marker before crossing the BB send boundary.'], ['Resolve', 'Record sent, released, or expired after reconciliation.']],
    cond: [{ q: 'Which durable activation key should represent the first turn after Start or Resume?', to: 'Activation and duplicate-delivery investigation' }],
  },
  {
    id: 'W', code: 'W', name: 'Continuation worker', short: 'WORKER', group: 'continuation',
    gx: 13, gy: 4, w: 3, d: 3, h: 48, kind: 'job',
    one: 'One cancellation-aware background service recovers and delivers eligible automatic work.',
    what: 'The worker reconciles thread ownership, retries missed idle events, recovers usage windows and ambiguous claims, assesses settled turns, and processes one durable Continuation at a time.',
    how: '<code>bb.background.service("continuations")</code> loops with bounded backoff and an abort signal. In-memory wake keys reduce latency but never replace SQLite state.',
    steps: [['Recover', 'Reconcile ownership, idle events, usage windows, claims, and unassessed sends.'], ['Claim', 'Lease one pending Continuation.'], ['Check', 'Ask the coordinator for current Goal and thread eligibility.'], ['Deliver', 'Send or release the claim, then wake for remaining work.']],
    cond: ['Can plugin reload or repeated idle events create multiple distinct opportunities for one idle boundary?'],
  },
  {
    id: 'G', code: 'G', name: 'Eligibility gate', short: 'USER FIRST', group: 'continuation',
    gx: 16, gy: 5, w: 2, d: 3, h: 50, kind: 'gate',
    one: 'The final gate yields to authoritative user activity and non-idle thread state.',
    what: 'Automatic work stops before delivery when the thread is archived, deleted, queued, active, in Plan mode, waiting on interaction, or running on a non-idle runtime.',
    how: '<code>goalContinuationEligibility</code> evaluates a fresh <code>GoalThreadSnapshot</code>. The send path rechecks immediately before crossing the gateway.',
    steps: [['Read snapshot', 'Fetch current thread, runtime, queue, Plan mode, interaction, and ownership state.'], ['Evaluate', 'Return eligible or one concrete reason code.'], ['Recheck', 'Repeat at the final send boundary.']],
    cond: [{ q: 'What outranks a Continuation?', r: 'Queued user messages, active or non-idle runtime, Plan mode, pending interactions, archive, and deletion (2026-08-26).' }],
  },
  {
    id: 'B', code: 'B', name: 'BB thread gateway', short: 'BB GATEWAY', group: 'bb',
    gx: 19, gy: 5, w: 3, d: 3, h: 34, kind: 'slab',
    one: 'The gateway reads authoritative thread state and sends agent-only Continuations.',
    what: 'This adapter is the plugin’s only route to thread snapshots, timeline observations, lifecycle ownership, delivery reconciliation, and automatic message sending.',
    how: '<code>GoalThreadGatewayAdapter</code> wraps documented BB SDK calls. Delivery uses a deterministic marker and <code>visibility: "agent-only"</code>.',
    steps: [['Read', 'Fetch current thread and runtime state.'], ['Reconcile', 'Search structured timeline rows for an existing delivery marker.'], ['Send', 'Ask BB to start one agent-only automatic turn.']],
    cond: [{ q: 'How can native Codex Goal activation and plugin Goal activation be made atomic?', to: 'SDK host-contract work; SDK 0.4.8 cannot close the read-to-send race' }],
  },
  {
    id: 'P', code: 'P', name: 'Provider agent', short: 'AGENT', group: 'bb',
    gx: 22, gy: 4, w: 3, d: 3, h: 70, kind: 'tall',
    one: 'Pi, Claude Code, Codex, or ACP pursues the same BB-owned Goal.',
    what: 'The provider receives Goal instructions and selected plugin tools at the BB agent boundary. Provider-native Goal implementations are not used as storage or lifecycle authority.',
    how: '<code>bb.agents.configure</code> contributes the exact Goal ID, revision, objective, authority rules, and tool schemas when an active Goal exists.',
    steps: [['Load context', 'BB injects the active objective and exact revision guard.'], ['Work', 'The provider uses ordinary coding and web tools.'], ['Report', 'The provider calls a guarded terminal tool only when its criteria are met.']],
    cond: [],
  },
  {
    id: 'F', code: 'F', name: 'Failure recovery', short: 'FAILURE REC.', group: 'safety',
    gx: 14, gy: 13, w: 3, d: 3, h: 44, kind: 'job',
    one: 'Structured terminal errors pause or defer automatic work without pretending the Goal is blocked.',
    what: 'Ordinary failures pause the Goal. Known subscription resets can recover after their full window passes. Unknown resets and credit or spend controls require manual resumption.',
    how: '<code>src/failure.ts</code> correlates event identity, scope, sequence, turn, blocked state, and every trustworthy reset window. The repository deduplicates durable failure facts.',
    steps: [['Observe', 'Read terminal error and blocked-state evidence.'], ['Classify', 'Separate ordinary failure, known reset, and manual-only usage limits.'], ['Persist', 'Pause or record the usage window once.'], ['Recover', 'After reset, re-run full Goal and eligibility checks before enqueueing.']],
    cond: [{ q: 'May an unknown usage reset resume automatically?', r: 'No. Only a trustworthy known subscription reset can recover automatically (2026-08-26).' }],
  },
  {
    id: 'N', code: 'N', name: 'No-progress guard', short: 'NO PROGRESS', group: 'safety',
    gx: 18, gy: 11, w: 2, d: 3, h: 50, kind: 'gate',
    one: 'Three automatic turns without structured progress pause the Goal atomically.',
    what: 'The guard protects the thread from repeating the same automatic response forever. It compares authoritative turn activity and a normalized fingerprint of the final structured agent message.',
    how: '<code>src/progress.ts</code> correlates delivery marker, request, accepted turn, scoped items, and completion. <code>src/repository.ts</code> records evidence and pauses count three in one transaction.',
    steps: [['Correlate', 'Prove the settled turn belongs to one sent Continuation.'], ['Map signals', 'Detect tools, file changes, external actions, interactions, and result fingerprint.'], ['Count', 'Reset on progress or increment the durable streak.'], ['Pause', 'At three, pause the same Goal revision and release pending work.']],
    cond: [{ q: 'What counts as no progress?', r: 'No qualifying structured signal and no changed normalized assistant result across the correlated automatic turn (2026-08-26).' }],
  },
  {
    id: 'A', code: 'A', name: 'Agent Goal context', short: 'GOAL CONTEXT', group: 'plugin',
    gx: 21, gy: 10, w: 3, d: 2, h: 42, kind: 'cards',
    one: 'A bounded synchronous snapshot selects Goal instructions and terminal tools for the provider.',
    what: 'Only an active Goal contributes context. Paused and finished Goals expose no Goal tools or instructions.',
    how: '<code>makeCurrentGoalSnapshotReader</code> performs one bounded direct SQLite read inside <code>bb.agents.configure</code>. Parameters pin the active Goal ID and revision.',
    steps: [['Snapshot', 'Read the unfinished Goal synchronously from the host database.'], ['Select', 'Return no tools unless the Goal is active.'], ['Pin', 'Constrain both tool schemas to the exact ID and revision.']],
    cond: ['How should a Goal started after a provider runtime loads refresh its selected tool catalog?'],
  },
  {
    id: 'X', code: 'X', name: 'Terminal Goal tools', short: 'TERM. TOOLS', group: 'plugin',
    gx: 24, gy: 9, w: 3, d: 2, h: 40, kind: 'cards',
    one: 'Namespaced tools complete or qualify Blockage against the exact active Goal revision.',
    what: 'Completion requires a concrete summary and verification evidence. Blockage requires the same normalized external action across reports one, two, and three.',
    how: '<code>bb_goal_complete</code> and <code>bb_goal_blocked</code> use plugin-owned names to avoid BB’s reserved Goal tool. The coordinator and repository reject stale, replaced, or cross-thread Goals.',
    steps: [['Validate input', 'Require exact Goal ID, revision, and terminal evidence.'], ['Guard', 'Re-read the active thread Goal in one transaction.'], ['Transition', 'Complete, qualify, or block without overwriting newer state.'], ['Publish', 'Return the DTO and emit goal.changed.']],
    cond: [{ q: 'Why are the tools namespaced?', r: 'The unnamespaced goal_complete collided with BB’s reserved session tool. bb_goal_complete passed a live Pi adapter smoke (2026-08-26).' }],
  },
  {
    id: 'L', code: 'L', name: 'Lifecycle reconciler', short: 'LIFECYCLE', group: 'safety',
    gx: 10, gy: 15, w: 3, d: 3, h: 44, kind: 'job',
    one: 'Archive and deletion events reconcile thread ownership until authoritative cleanup succeeds.',
    what: 'Archive pauses Goal work. Unarchive does nothing automatically. Delete removes every plugin-owned row family. Forked threads do not inherit Goal state.',
    how: '<code>server.ts</code> queues thread-scoped ownership reconciliation with bounded cancellation-aware backoff. Startup scans owned thread IDs so a missed event does not strand state.',
    steps: [['Queue', 'Record the thread as needing ownership reconciliation.'], ['Read owner', 'Check authoritative existence, archive, and deletion state.'], ['Apply', 'Pause archived work or delete all plugin-owned state.'], ['Retry', 'Keep the thread queued until reconciliation succeeds or disposal cancels it.']],
    cond: [{ q: 'Should unarchive resume a Goal automatically?', r: 'No. Unarchive is inert; the user must resume deliberately (2026-08-26).' }],
  },
];

export const FLOWS = [
  {
    id: 'start', name: 'Start and inspect a Goal', hops: [
      ['H', 'U', 'objective', { objective: 'Publish the Goal plugin' }, 'yx'],
      ['U', 'S', 'rpc.start', { threadId: 'thr_…', objective: 'Publish the Goal plugin' }, 'xy'],
      ['S', 'O', 'start command', { type: 'start', threadId: 'thr_…' }, 'xy'],
      ['O', 'D', 'atomic insert', { state: 'active', revision: 1 }, 'yx'],
      ['D', 'S', 'Goal DTO', { goalId: 'goal_…', state: 'active', revision: 1 }, 'xy'],
      ['S', 'U', 'goal.changed', { threadId: 'thr_…', revision: 1 }, 'yx'],
    ],
  },
  {
    id: 'continue', name: 'Deliver one Continuation', hops: [
      ['T', 'E', 'thread.idle', { threadId: 'thr_…', seq: 410 }, 'yx'],
      ['E', 'S', 'idle event', { eventId: 'evt_…', seq: 410 }, 'xy'],
      ['S', 'O', 'enqueue idle', { opportunityKey: 'idle:evt_…' }, 'xy'],
      ['O', 'Q', 'pending record', { goalRevision: 3, state: 'pending' }, 'yx'],
      ['Q', 'W', 'leased claim', { attempt: 1, state: 'claimed' }, 'xy'],
      ['W', 'G', 'fresh snapshot', { queued: 0, runtime: 'idle' }, 'xy'],
      ['G', 'B', 'eligible send', { marker: 'bb-goal-continuation:goal_…' }, 'xy'],
      ['B', 'T', 'agent-only request', { initiator: 'system', target: 'auto' }, 'yx'],
      ['T', 'P', 'Goal turn', { provider: 'replaceable' }, 'xy'],
    ],
  },
  {
    id: 'complete', name: 'Complete the exact Goal', hops: [
      ['D', 'A', 'active snapshot', { goalId: 'goal_…', revision: 3 }, 'xy'],
      ['A', 'P', 'instructions + tools', { tools: ['bb_goal_complete', 'bb_goal_blocked'] }, 'yx'],
      ['P', 'X', 'bb_goal_complete', { goalId: 'goal_…', expectedRevision: 3 }, 'xy'],
      ['X', 'O', 'complete command', { summary: 'Released and verified' }, 'yx'],
      ['O', 'D', 'guarded transition', { from: 'active', to: 'completed', revision: 4 }, 'xy'],
      ['D', 'S', 'completed DTO', { state: 'completed', revision: 4 }, 'yx'],
      ['S', 'U', 'goal.changed', { state: 'completed' }, 'xy'],
    ],
  },
  {
    id: 'recover', name: 'Recover from a provider limit', hops: [
      ['T', 'E', 'terminal failure', { code: 'rate_limit', turnId: 'turn_…' }, 'yx'],
      ['E', 'F', 'structured facts', { resetAt: '2026-08-27T00:00:00Z' }, 'xy'],
      ['F', 'O', 'pause or recover', { kind: 'subscription', reliableReset: true }, 'xy'],
      ['O', 'D', 'durable state', { state: 'paused', reason: 'usage-limit' }, 'yx'],
      ['D', 'W', 'reset becomes due', { goalRevision: 3 }, 'xy'],
      ['W', 'G', 'full eligibility recheck', { nowAfterReset: true }, 'xy'],
    ],
  },
  {
    id: 'ownership', name: 'Reconcile archive or deletion', hops: [
      ['T', 'E', 'lifecycle event', { archived: true, deleted: false }, 'yx'],
      ['E', 'L', 'ownership pending', { threadId: 'thr_…' }, 'xy'],
      ['L', 'B', 'authoritative read', { read: 'ownership' }, 'xy'],
      ['B', 'L', 'thread ownership', { exists: true, archived: true }, 'yx'],
      ['L', 'O', 'pause archive work', { reason: 'thread-archived' }, 'xy'],
      ['O', 'D', 'atomic cleanup', { releasePending: true }, 'yx'],
    ],
  },
];

export const CH = [
  {
    id: 'thread', title: 'A person and a thread', reveal: ['H', 'T'],
    lede: 'The objective belongs to the BB thread, not to whichever provider happens to answer.',
    story: '<p>The human owns the outcome. The thread supplies the durable identity. <mark>Provider sessions can change without replacing the Goal.</mark></p>',
    flow: [
      ['H', 'T', 'user request', { text: 'Keep working until this is shipped' }],
      ['T', 'H', 'thread result', { status: 'idle' }],
    ],
  },
  {
    id: 'controls', title: 'Starting and seeing a Goal', reveal: ['U', 'C'],
    lede: 'BB-native controls keep Goal state visible without turning lifecycle commands into prompts.',
    story: '<p>The composer card and panel are the everyday path. The CLI offers the same operations to scripts and terminals. <mark>Both paths use guarded structured commands.</mark></p>',
    flow: [
      ['H', 'U', 'start Goal', { objective: 'Ship and verify' }],
      ['U', 'T', 'thread Goal', { state: 'active', revision: 1 }],
      ['T', 'U', 'status', { state: 'active' }],
    ],
  },
  {
    id: 'control', title: 'One control path', reveal: ['S', 'O'],
    lede: 'UI, CLI, events, and agent tools converge on one typed state machine.',
    story: '<p>The server translates BB calls. The coordinator owns domain rules and returns typed outcomes. <mark>No entry point writes Goal state on its own.</mark></p>',
    flow: [
      ['T', 'S', 'Goal command', { type: 'edit', expectedRevision: 1 }],
      ['S', 'O', 'typed command', { type: 'edit' }],
      ['O', 'S', 'Goal DTO', { revision: 2 }],
      ['S', 'T', 'goal.changed', { revision: 2 }],
    ],
  },
  {
    id: 'durability', title: 'Durable state and evidence', reveal: ['D', 'E'],
    lede: 'SQLite stores decisions; BB’s timeline proves what happened outside the database.',
    story: '<p>The repository makes transitions atomic. Structured timeline rows correlate requests, turns, tool activity, failures, and lifecycle events. <mark>Neither memory nor assistant prose is authoritative.</mark></p>',
    flow: [
      ['T', 'E', 'structured rows', { requestId: 'creq_…', turnId: 'turn_…' }],
      ['E', 'O', 'observation', { terminal: 'completed', scoped: true }],
      ['O', 'D', 'atomic evidence', { assessed: true }],
      ['D', 'O', 'stored result', { revision: 2 }],
    ],
  },
  {
    id: 'ledger', title: 'A Continuation becomes durable', reveal: ['Q', 'W'],
    lede: 'An idle signal creates a durable opportunity before any automatic message is sent.',
    story: '<p>The ledger gives work an identity. The worker recovers claims and ambiguous sends after restart. <mark>Wake-ups improve latency; SQLite decides what still exists.</mark></p>',
    flow: [
      ['E', 'S', 'thread.idle', { eventId: 'evt_idle' }],
      ['S', 'O', 'enqueue', { opportunityKey: 'idle:evt_idle' }],
      ['O', 'Q', 'pending', { state: 'pending' }],
      ['Q', 'W', 'claim', { state: 'claimed', attempt: 1 }],
    ],
  },
  {
    id: 'send', title: 'User first, then delivery', reveal: ['G', 'B', 'P'],
    lede: 'The worker sends only after a fresh authority check at the last possible moment.',
    story: '<p>The gate checks queue, runtime, Plan mode, interactions, archive, and deletion. The gateway sends one agent-only message with a deterministic marker. <mark>Human activity wins every race the host can expose.</mark></p>',
    flow: [
      ['W', 'G', 'fresh snapshot', { status: 'idle', queued: 0 }],
      ['G', 'B', 'eligible', { reason: null }],
      ['B', 'T', 'agent-only Continuation', { marker: 'bb-goal-continuation:goal_…' }],
      ['T', 'P', 'Goal turn', { provider: 'pi | claude | codex | acp' }],
    ],
  },
  {
    id: 'failure', title: 'Failures are not Blockage', reveal: ['F'],
    lede: 'Provider errors and usage limits pause or defer work through a separate recovery path.',
    story: '<p>Ordinary failures pause. A reliable subscription reset may recover after its full window. Credit limits need a human. <mark>The plugin never converts provider trouble into agent-reported Blockage.</mark></p>',
    flow: [
      ['T', 'E', 'terminal error', { code: 'rate_limit' }],
      ['E', 'F', 'correlated failure', { turnId: 'turn_…', resetAt: '…' }],
      ['F', 'O', 'pause command', { reason: 'usage-limit' }],
      ['O', 'D', 'durable pause', { state: 'paused' }],
    ],
  },
  {
    id: 'progress', title: 'Stop an empty loop', reveal: ['N'],
    lede: 'Three automatic turns without structured progress pause the Goal.',
    story: '<p>The guard correlates the exact automatic request and accepted turn. It records tool activity, file changes, external actions, interactions, and the final result fingerprint. <mark>Count three pauses in the same transaction that records the evidence.</mark></p>',
    flow: [
      ['Q', 'E', 'sent Continuation', { continuationId: 'cont_…' }],
      ['E', 'N', 'settled observation', { signals: [], sameResult: true }],
      ['N', 'O', 'pause at count 3', { reason: 'no-progress' }],
      ['O', 'D', 'evidence + pause', { consecutive: 3, state: 'paused' }],
    ],
  },
  {
    id: 'terminal', title: 'Finish, block, archive, or delete', reveal: ['A', 'X', 'L'],
    lede: 'Exact revision guards close the Goal while lifecycle reconciliation keeps thread ownership honest.',
    story: '<p>The agent receives bounded context and namespaced terminal tools. Archive pauses; delete cleans every owned table; forks inherit nothing. <mark>Every terminal write rechecks the same active Goal revision.</mark></p>',
    flow: [
      ['D', 'A', 'active snapshot', { goalId: 'goal_…', revision: 3 }],
      ['A', 'P', 'Goal tools', { selected: ['bb_goal_complete', 'bb_goal_blocked'] }],
      ['P', 'X', 'complete', { expectedRevision: 3, evidence: '116 tests pass' }],
      ['X', 'O', 'guarded command', { type: 'complete' }],
      ['O', 'D', 'terminal transition', { state: 'completed', revision: 4 }],
    ],
  },
  {
    id: 'all', title: 'The whole Goal system', reveal: [],
    lede: 'Choose a flow and inspect every packet, structure, decision, and open question.',
    story: '<p>The map now shows the complete path from human intent to durable state, automatic delivery, provider work, recovery, and terminal evidence. Choose a flow at bottom left. Hover to read; click to pin; use the arrow key to go inside. The <mark>Open questions</mark> tab tracks the contracts that still need work.</p>',
    flow: null,
  },
];

export const HOW_HTML = `<div class="eyebrow">Goal · v0.1.1</div><h1 class="t">How it is built</h1><div class="sub">one BB plugin, one host database, one managed worker</div>
<h3 class="sec">Runtime split</h3>
<p><code>app.tsx</code> renders BB-native controls. <code>server.ts</code> registers host adapters and owns one managed Effect runtime. The coordinator contains domain rules; the repository contains atomic SQLite changes.</p>
<h3 class="sec">Authority</h3>
<p>BB thread state and structured timeline rows are authoritative outside the plugin database. The Goal revision and durable ledgers are authoritative inside it.</p>
<h3 class="sec">Filesystem</h3>
<pre>app.tsx
server.ts
src/
  coordinator.ts
  repository.ts
  runtime.ts
  failure.ts
  progress.ts</pre>
<h3 class="sec">Build both views</h3>
<pre>node docs/goal/atlas/build.mjs</pre>`;
