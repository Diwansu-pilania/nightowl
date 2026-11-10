# NightOwl

A local terminal chat harness that keeps your conversation and task notes when
you switch models. **v0.1.0-alpha.2** connects to cloud models through
**OpenRouter** or local models through **Ollama**. This is a continuity alpha;
file editing and command execution are planned for a later release.

Built with TypeScript, React, Bun, and [OpenTUI](https://github.com/sst/opentui).

## Features

- Streaming chat: replies appear word by word; **Esc** stops one mid-way
- Works with OpenRouter (hundreds of models) or Ollama (free, offline)
- `/` command menu with keyboard and mouse support (`/new`, `/exit`, ...)
- Clear in-app messages for setup problems (missing key, Ollama not running)
- Conversations saved locally in SQLite, with automatic resume in each workspace
- `/sessions` picker and `/new` that keeps previous conversations
- Checkpointed partial replies and recovery after an interrupted process
- `/models` setup, searchable model lists, and switching providers inside a chat
- Masked API-key entry with optional local credential storage
- Model-specific context budgets, automatic local compaction, and a `/context` inspector
- `/memory` task notes that survive switching and restarting; `/compact` for manual compaction
- Chat and input use the terminal width, with basic Markdown and code display
- `/rename`, `/export`, and `/import` for portable text conversations and task notes
- Headless end-to-end UI tests with a mock model

## Quick start

### Windows x64 release

Download the ZIP and matching `.sha256` file from
[GitHub Releases](https://github.com/Diwansu-pilania/nightowl/releases).
Choose **v0.1.0-alpha.2 or newer**: alpha.1 has a ZIP layout bug that can cause
Windows "Extract all" to reject the archive or WinRAR to report a folder error.
Extract the ZIP with Windows **Extract all** or WinRAR, open PowerShell in the
extracted folder, and run:

```powershell
.\nightowl.exe --setup
```

The archive includes the runtime; you do not need Bun or Node.js. Keep its license
files. The binary is unsigned. Check the downloaded ZIP with
`Get-FileHash .\nightowl-v0.1.0-alpha.2-windows-x64.zip -Algorithm SHA256`
against the supplied checksum. A checksum detects changes; it does not authenticate
the publisher. Only download from this repository's releases.

### From source

Requires Git and [Bun](https://bun.sh) **1.4.2**.

```bash
git clone https://github.com/Diwansu-pilania/nightowl.git
cd nightowl
bun install --frozen-lockfile
bun run start --setup
```

Choose OpenRouter and enter your API key, or choose Ollama after installing it
and downloading a model (for example, `ollama pull llama3.2`). Ollama runs as a
separate local service; start it before connecting. Setup never
downloads models automatically. Later launches use `bun run start`.

You can also copy `.env.example` to `.env` and configure the variables below.
Use `bun run dev:cli` when developing with automatic reloads.

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Supply an OpenRouter key; takes precedence over a saved key |
| `NIGHTOWL_PROVIDER` | Override the saved provider at launch (`openrouter` or `ollama`) |
| `NIGHTOWL_MODEL` | Override the saved model at launch |
| `OLLAMA_BASE_URL` | Ollama on a different host or port |
| `NIGHTOWL_DATA_DIR` | Override the local directory for sessions, settings, and optional credentials |

## Change models during a conversation

1. Enter `/models` and choose Ollama or OpenRouter.
2. Search the model list, use the arrow keys, and press Enter.
3. If a reply is running, confirm whether to stop it and switch. Its partial
   text stays saved.
4. Send your next message (for example, "continue the task"). The new model
   receives budgeted context from the saved conversation, with interrupted answers labeled.

The session ID and prior replies stay intact. Each reply shows its original
provider/model. Selecting a model performs connection checks, not paid test
generation, and never automatically restarts a failed reply. OpenRouter credit
and rate-limit errors suggest `/models` so you can continue with another model.

In the model list, Ctrl+R refreshes, Ctrl+E changes connection settings, and
Ctrl+M accepts a model ID manually. OpenRouter IDs entered manually are checked
for availability when you send a message. Ollama checks that the model exists
on the configured server. Catalog access/key validation does not guarantee a
cloud model is available to your account or that you have sufficient credits.

OpenRouter key entry is hidden. Enter uses the key for this run only; Ctrl+S
explicitly saves it in a local, **unencrypted** `credentials.json`. Preferences
live in `settings.json`. POSIX file modes restrict access where supported;
Windows uses the user's application-data directory permissions. These files
are separate from conversation storage. Environment keys take precedence on
restart; keys entered in the picker take precedence for the current run.

Model selections persist per session. Explicit `NIGHTOWL_PROVIDER` or
`NIGHTOWL_MODEL` values override the session on launch; unset them if you want
the picker selection restored unchanged. Credentials/server configuration are
resolved at runtime and never embedded into saved switch events.

## Saved conversations

NightOwl automatically reopens the last conversation in the current working
directory. `/new` starts another conversation and `/sessions` opens the picker;
older conversations are kept. A selected conversation can only be edited by one
NightOwl process at a time.

```bash
bun run start --new
bun run start --sessions
bun run start --resume <full-session-id>
bun run start --help
```

Data stays in `%LOCALAPPDATA%/NightOwl` on Windows,
`~/Library/Application Support/NightOwl` on macOS, or
`${XDG_DATA_HOME:-~/.local/share}/nightowl` on Linux. `NIGHTOWL_DATA_DIR`
overrides this location. Messages, error text, and provider/model attribution
are stored locally; configured API keys are not stored in the session database.
Conversation contents can still contain sensitive information you type or a
model returns. The database is not encrypted.

Responses are checkpointed every 150 ms while text arrives and flushed on stop
or normal exit. A hard crash can lose the last unflushed fragment; a recovered
reply is marked `(stopped)` and is never automatically sent again. A storage
error blocks new sends and keeps unsaved text on screen.

**Current scope:** requests use budgeted context, with local excerpts of older
turns when needed. Compaction is lossy; keep essential constraints in `/memory`.
Plan/Build agents and coding tools are not part of this release.
Local Ollama use makes no background cloud discovery or summary
calls; choosing OpenRouter sends conversation context there on your next turn.

On the first launch after this update, schema v1/v2 databases are backed up to a
timestamped `.sqlite` file beside the database and upgraded to v3. Close other
NightOwl processes before upgrading. Older NightOwl builds cannot open v3 data.

## Context and task memory

`/context` shows the estimated input size, context window, reserved reply tokens,
and which messages are included, excerpted, or excluded. Press **B** to set a
window and reply limit for the current model in this conversation. **D** restores
the default limits, and **L** switches between a current-history preview and the
last saved request/compaction record. The preview does not include your unsent draft.

NightOwl uses OpenRouter catalog limits when known and saves those limits for
selected models. Models without known limits default to an 8,192-token window
on OpenRouter or 4,096 on Ollama. For Ollama, set the window to match the server's
effective `num_ctx`; NightOwl's budget setting does not reconfigure the server.
Counts conservatively use UTF-8 byte lengths plus framing overhead, not an exact
model tokenizer or billed usage. A safety margin and a bounded reply reserve are
subtracted from the window. The reply limit is sent to the provider; a reply
ending at its token limit is marked `(stopped)` and retained as incomplete.

For an OpenRouter model selected before this update, reselect it in `/models`
once to discover and save its catalog limits, or set the limits in `/context`.

`/memory` opens editable, user-maintained task notes for the current conversation.
Use **Ctrl+S** to save, **Esc** to cancel, or clear the text and save to remove notes.
Notes are included in full as user context on subsequent requests and survive
restart and model switching. New conversations start with empty notes. This
version does not infer permanent facts or share memory across projects/chats.

When full history exceeds the input budget, NightOwl keeps the latest message,
task notes, and recent whole turns, then selects bounded excerpts from older
turns. Original messages are never rewritten or deleted. The chat displays a
compaction notice, and `/context` exposes source IDs and exact excerpts. If the
latest input and notes cannot fit, nothing is sent and the draft stays in the
editor. Shorten it or change the model/limits before submitting again.

`/compact` enables this local compaction policy before the next request. In
`/context`, **R** restores full history whenever it fits. Compaction does not make
LLM calls, use credits, or generate a semantic summary; excerpts can omit important
information. Notes are the reliable way to carry essential facts into each request.

## Rename and move a conversation

Use `/rename`, `/export`, or `/import` to open the corresponding dialog. Exports
use a versioned `.nightowl.json` format. Import creates a separate conversation
in your current workspace, with fresh IDs, and never starts a model request.
In the app, the currently selected provider remains selected after import.

The same operations work without starting the terminal UI:

```bash
bun run start --rename "My project"
bun run start --export ./my-project.nightowl.json
bun run start --import ./my-project.nightowl.json
bun run start --resume <full-session-id> --export ./another-copy.nightowl.json
```

For the Windows release, replace `bun run start` with `.\nightowl.exe`.
Exports contain text, title, current task notes, reply status, and provider/model
attribution. They exclude configured credentials, endpoints, workspace paths,
context-budget settings, compaction records, and request/switch event history.
Sensitive text typed into a conversation can still appear in an export. Review
the file before sharing it. Export never overwrites an existing file. Imports
are limited to 10 MiB and support text-only conversations; active replies become
interrupted. Headless imports have no selected provider until you open the chat.

## Keys

| Key | Action |
|---|---|
| Enter / Shift+Enter | Send / new line |
| `/` | Open the command menu |
| Esc | Stop the current reply, or close the menu |
| Ctrl+C | Quit |

## Development

```bash
bun run test        # core persistence/recovery, config, AI layer, full UI
bun run typecheck
bun run build:cli   # compile for the current OS/architecture (tested with Bun 1.4.2)
bun run package:release  # Windows x64 ZIP and SHA-256, including licenses
bun run smoke:package    # unpack and verify the release using isolated data
```

The build writes `dist/nightowl.exe` on Windows or `dist/nightowl` elsewhere.
Compiled builds use saved user settings or explicit environment variables and do not automatically
load a project's `.env` or `bunfig.toml`. Source development keeps Bun's normal
`.env` behavior. Windows x64 is the initial binary target. GitHub CI checks source
tests and types on Windows, macOS, and Linux; source checks alone do not certify
interactive terminal behavior or binary support. Real OpenRouter chat was tested
manually. Ollama's HTTP integration has automated fixture coverage; real local
inference remains an alpha testing gap.

The UI lives in `packages/cli`; `packages/core` owns configuration, AI requests,
session lifecycle, and SQLite storage without importing React.
See [the persistence implementation](docs/persistent-sessions.md),
[provider setup and switching](docs/provider-switching.md),
[context and task memory](docs/context-and-memory.md),
[the build/release plan](docs/build-and-release-plan.md), and
[the original Phase 1 guide](docs/phase-1-chat.md).

## Roadmap

- [x] Phase 1: streaming chat (OpenRouter + Ollama)
- [x] Persistent text sessions, resume, and recovery
- [x] Provider setup and `/models` switching within a saved conversation
- [x] Context budgeting, local excerpt compaction, and explicit session task notes
- [x] Session rename/export/import and basic Markdown/code display
- [ ] Model-generated summaries and project/user memory scopes
- [ ] Public continuity alpha and tested platform releases
- [ ] Coding tools and Plan/Build modes with permissions
- [ ] Themes and further customization
