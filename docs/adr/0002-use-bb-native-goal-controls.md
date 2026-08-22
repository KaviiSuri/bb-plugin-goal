# Use BB-native Goal controls instead of a slash command

Start and manage Goals through a persistent composer card, with history in a thread panel and equivalent `bb goal` CLI commands. Do not ship a `/goal` skill in v1. BB can expose Goal state directly, while a slash command would collide with Codex's provider-native `/goal` and would make management depend on prompt parsing.
