# No-progress observation

BBG-11 uses BB's stored structured thread events. It does not inspect assistant prose for claims about work.

## Continuation boundary

An assessment starts only when all of these rows form one ordered chain:

1. `client/turn/requested` has the Continuation's durable delivery marker in structured input, `initiator: "system"`, `target.kind: "auto"`, and a request ID.
2. A later turn-scoped `turn/input/accepted` has the same request ID in `clientRequestId`.
3. A later `turn/completed` has the accepted turn scope and `status: "completed"`.

Failed and interrupted terminals remain failure/usage concerns. Manual requests, unaccepted requests, cross-turn items, delayed predecessor rows, and ambiguous chains do not produce a no-progress assessment.

## Progress mapping

- Tool calls: turn-scoped `item/started` or `item/completed` with `commandExecution` or `toolCall`.
- File mutations: turn-scoped `fileChange` items with at least one change, or a non-empty `turn/diff/updated` diff.
- External actions: turn-scoped web search, web fetch, image view, or background task items.
- Pending interactions: turn-scoped permission-grant or user-question lifecycle rows whose status is `pending`.
- Assistant result: the last completed turn-scoped `agentMessage` before the terminal row. Its NFKC-normalized, whitespace-collapsed text is stored as a SHA-256 fingerprint.

The first structured assistant result for a Goal revision differs from the empty baseline and resets the streak. Later equal fingerprints do not count as progress. BB does not currently expose a separate provider-independent semantic result object, so normalized `agentMessage` is the narrowest documented structured fallback.

## Durable state

The Goal stores the consecutive count, last assessed Continuation ID, latest assistant fingerprint, and bounded evidence containing only row IDs, sequences, the turn and request IDs, signal categories, fingerprints, and assessment time. Each sent Continuation stores whether it was assessed and its evidence.

Assessment and a possible pause run in one SQLite transaction. The transaction rechecks Goal ID, revision, active state, prior terminal sequence, and the unassessed sent Continuation. At count three it changes the Goal to `paused` with reason code `no-progress` and releases pending Continuations for the old revision. Startup recovery scans sent, unassessed Continuations before it processes pending sends.

Editing a Goal starts a new revision and clears the streak. Manual resume also clears the streak and fingerprints, which gives the user a new three-attempt allowance. Manual pause preserves evidence until resume.
