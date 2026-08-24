# BB Goal plugin

Goal keeps one durable, provider-independent objective on an existing BB thread. BB owns the state in the plugin database, so the objective survives plugin reloads, server restarts, and provider changes.

## Contributor setup

```sh
npm install
npm run check
```

Effect is pinned to `4.0.0-beta.107`. Before changing or reviewing Effect code, read `node_modules/effect/AGENTS.md` completely and follow the linked guidance that applies to the change. Do not update Effect through the floating `beta` tag.

The coordinator adapts BB's host-owned `better-sqlite3` handle. It must never open a second connection or close BB's handle.

## Use

Install the checkout as a path plugin:

```sh
bb plugin install .
```

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

Pass `thr_example` after any subcommand to target that thread explicitly. Mutations use the current Goal revision as a compare-and-swap guard, so a concurrent edit or transition fails instead of overwriting newer state.
