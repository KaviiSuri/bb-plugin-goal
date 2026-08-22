# Issue tracker: BB Tasks

Issues and specs for this repository live in the BB Tasks project `BBG`, which is linked to BB project `proj_ytyn49ittb`. Use the `bb tasks` CLI for all tracker operations.

## Conventions

- Create: `bb tasks create --project BBG --title "..." --description-file <path>`
- Read: `bb tasks show BBG-<number>`
- List: `bb tasks list --project BBG --limit 100`
- Comment: `bb tasks comment BBG-<number> --body "..."`
- Label: `bb tasks update BBG-<number> --add-label <label>` or `--remove-label <label>`
- Set status: `bb tasks update BBG-<number> --status <status>`
- Add a blocking edge: `bb tasks dependency add <dependent> --blocked-by <blocker>`
- List blocking edges: `bb tasks dependency list BBG-<number>`

Valid statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and `canceled`.

## Skill translations

When a skill says to publish to the issue tracker, create a task in project `BBG`. When it says to fetch a ticket, use `bb tasks show`. Use task comments for durable findings and native dependencies for blocking relationships.

For a parent effort with child tickets, create one task as the parent and set each child with `bb tasks update <child> --parent <parent>`. A ticket is ready to claim when it has no open blocker and no attached working thread.
