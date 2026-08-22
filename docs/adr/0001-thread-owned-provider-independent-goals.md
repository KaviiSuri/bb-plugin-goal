# Keep Goals thread-owned and provider-independent

Store Goal state in the plugin against the BB thread and drive every provider through BB agent tools, instructions, and thread turns. Provider-native Goal implementations, including Codex Goal, are references rather than dependencies. This gives Pi, Claude Code, Codex, and ACP the same lifecycle and preserves a Goal across provider-session or model changes.
