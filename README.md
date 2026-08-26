# BB Goal plugin

Goal keeps one durable, provider-independent objective on an existing BB thread. BB owns the state in the plugin database, so the objective survives plugin reloads, server restarts, and provider changes.

## Contributor setup

```sh
npm install
npm run check
```

Effect is pinned to `4.0.0-beta.107`. Before changing or reviewing Effect code, read `node_modules/effect/AGENTS.md` completely and follow the linked guidance that applies to the change. Do not update Effect through the floating `beta` tag.

The coordinator adapts BB's host-owned `better-sqlite3` handle. It must never open a second connection or close BB's handle.

Agent Goal context uses `bb.agents.configure`, which is synchronous. Its callback performs one bounded direct SQLite read and never runs an asynchronous Effect program. For an active Goal, BB selects the provider-independent `goal_complete` and `goal_blocked` tools and contributes the exact Goal ID, revision, objective, authority rules, and terminal-outcome requirements. Completion requires a summary and verification evidence. Blockage requires the external action, concrete evidence, and the same blocker across at least three consecutive Goal turns. Each report applies one atomic revision-guarded transition. The current BB agent-tool contract does not expose a trustworthy provider turn ID, so qualification uses the structured monotonic report count and normalized external-action identity in durable SQLite; it does not parse transcript text.

## Install

Install a tagged Git release:

```sh
bb plugin install git:https://github.com/KaviiSuri/bb-plugin-goal.git@v0.1.0
```

For local development, install the checkout as a path plugin:

```sh
bb plugin install .
```

## Use

Start and inspect a Goal in a BB thread:

```sh
bb goal start "Ship the parser and verify its error cases"
bb goal status
```

Target another thread or read a long objective from a file:

```sh
bb goal start thr_example --objective-file ./objective.md
bb goal status thr_example --json
```

Edit or control the unfinished Goal from the current thread context:

```sh
bb goal edit "Ship the parser and its recovery cases"
bb goal pause
bb goal resume --json
bb goal cancel
```

Browse sequential history, inspect one opaque Goal ID, or deliberately delete one record:

```sh
bb goal history thr_example --limit 20
bb goal history thr_example --cursor <opaque-cursor> --json
bb goal show goal_example
bb goal delete goal_example --yes
```

Thread-scoped commands accept `thr_example` after the subcommand. `show` and `delete` target an opaque Goal ID directly; deletion always requires `--yes`. Mutations use the current Goal revision as a compare-and-swap guard, so a concurrent edit or transition fails instead of overwriting newer state. Completed Goals retain the agent's summary and verification evidence in `history`/`show` JSON, human-readable `show` output, and the Goal history panel.

## Releasing

Releases are immutable annotated Git tags (`vX.Y.Z`). Each release commit contains the bumped manifest and freshly built `dist/` artifacts, so BB can install the reviewed build directly. Pull requests and main pushes run `.github/workflows/ci.yml` on Node 22.

Cut a local release without publishing it:

```sh
scripts/release.sh patch
scripts/release.sh minor
scripts/release.sh 1.4.2
```

Add `--push` to atomically publish the release commit and tag. Nothing is pushed without that flag.

For an on-demand GitHub release, run the **Release** workflow from Actions or use:

```sh
gh workflow run release.yml -f bump=patch
```

The workflow runs the complete check, bumps the selected version, rebuilds versioned artifacts, atomically pushes `main` and the tag, and creates GitHub release notes. A custom version uses `-f bump=custom -f custom_version=1.4.2`.
