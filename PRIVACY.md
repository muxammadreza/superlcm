# Privacy

SuperLcm runs entirely on your computer. Its author operates no server, collects no telemetry and receives none of your data.

## What SuperLcm stores

After each turn, SuperLcm copies the conversation from the connected tool's own transcript (Claude Code, Codex, Pi or dsh) into a folder on your computer, `~/.superlcm-claude` by default (or `SUPERLCM_HOME`). That includes everything you and the agent wrote and the agent's tool calls and their output, plus the summaries SuperLcm keeps. An API key you enter for the custom API option is stored in the same folder in a private transactional credential database. Legacy JSON credentials remain readable for compatibility.

You can delete a conversation from the console, and removing the folder removes everything SuperLcm has stored.

Deleting a custom model unbinds its key and cleans unreachable versions from that model's scope in the credential database and the legacy JSON file. A copy used by another model or setting remains in its own scope. Cleanup waits for any credential save in progress and retries later if it cannot finish; the Settings page identifies scopes still awaiting cleanup. This removes live database entries, not copies in backups, filesystem snapshots, or existing SQLite journals. Conversation deletion likewise removes SuperLcm's live records, not the original transcript held by the tool or copies in backups and snapshots.

## What leaves your computer

Only summary writing can send conversation text anywhere, and only to a model you have chosen, in the mode you pick per tool:

- **Main-model background branch** (default): a separate branch uses the conversation’s model and configured account to prepare a summary tree. The active conversation continues while it is prepared. A model override uses the selected tool’s model and account configuration.
- **Legacy tool CLI** (preserved explicit settings): a short background run of Claude Code, Codex or Pi sends excerpts to that tool's model provider under the account you already signed in with.
- **Custom API**: excerpts are sent to the endpoint you enter, with the key you enter. A local endpoint such as `http://127.0.0.1` stays on your computer.
- **Off**: nothing is sent; conversations are still saved and searchable.

The console listens on `127.0.0.1` only. Access from your other devices over Tailscale is off unless you turn it on (see [docs/CONSOLE.md](docs/CONSOLE.md)).

## Contact

Questions and reports: https://github.com/yu381792/superlcm/issues
