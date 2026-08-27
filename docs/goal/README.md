# Goal architecture

The Goal architecture has one editable model and two generated views.

| File | Role | Edit it? |
|---|---|---|
| [`atlas/data.mjs`](./atlas/data.mjs) | Structures, flows, chapters, decisions, questions, and prose | Yes |
| [`atlas/template.html`](./atlas/template.html) and [`atlas/build.mjs`](./atlas/build.mjs) | Interactive renderer and generator | Only when changing presentation or generation |
| [`atlas.html`](./atlas.html) | Interactive isometric atlas | No, generated |
| [`SYSTEM.md`](./SYSTEM.md) | Complete text twin | No, generated |
| [`../../CONTEXT.md`](../../CONTEXT.md) | Goal glossary | By hand |
| [`../adr/`](../adr/) | Decisions that need a durable rationale | By hand |

Rebuild both generated views after changing `atlas/data.mjs`:

```sh
node docs/goal/atlas/build.mjs
```
