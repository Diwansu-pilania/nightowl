# Context budgets, local compaction, and task notes

Implemented on 11 November 2026. This is the deterministic first slice from the
build plan: bounded requests and explicit session memory, with no model-generated
summary calls. The user independently confirmed OpenRouter chat works; this
milestone's automated inference checks use fixtures, not a paid account.

## Request assembly

The core's `context/builder.ts` builds each request from original saved messages.
System policy stays in the system role. Explicit task notes and labeled older
excerpts enter as user context, followed by a contiguous suffix of whole recent
turns and the latest instruction. Assistant excerpts are labeled as claims, with
interrupted answers marked incomplete. Failed, empty, and actively streaming
answers are excluded; none of these operations modify the transcript.

Effective input budget = context window - maximum reply tokens - safety margin.
The default reply reserve is the smaller of 2,048 and one quarter of the window.
An explicit reply setting can use up to half the window, subject to known provider
output limits. Safety margin is the greater of 256 and ten percent of the window.
Requests include the reply limit through the compatible provider adapter.
Length-limited responses are persisted as interrupted and replayed with that label.

Counting uses UTF-8 byte lengths, 16 per message, and 32 for system framing. This
intentionally overestimates typical text substantially and is not a tokenizer.
Counts include notes, source labels, partial-response labels, and summary framing.
They are not billed usage or a universal guarantee across model/server templates.

OpenRouter catalog context/output limits follow the selected model and are saved
in preferences. Unknown/manual model IDs use 8,192 tokens until a known catalog
entry or user override supplies a limit. Ollama uses 4,096 as a conservative
default: users should match `/context` to the running server's effective `num_ctx`.
Advertised Ollama architecture maxima are deliberately not treated as effective
capacity. This version neither sets `num_ctx` nor interrogates running allocations.
Lower effective server limits can still reject or truncate requests; configure
the budget before relying on continuity. Increasing a budget does not increase
the model's capacity. Catalog values can be refreshed through `/models`.

## Local compaction policy

When history exceeds the input budget, preserve task notes and the newest turn
in full, then retain recent coherent turn groups while reserving room for older
evidence. On send, that newest turn is the pending user message. If these mandatory
items cannot fit, refuse before creating a turn or making a network request;
keep the draft in the editor and show an actionable error.

Older evidence is selected from bounded sentence/line excerpts. The selection
weights initial intent, user instructions, and words indicating constraints,
decisions, or pending work, then deduplicates repeated text. Source message IDs,
roles, interruption labels, and UTF-16 character offsets accompany each excerpt.
At most the first 200 segments of each older message are candidates; individual
excerpts are at most 500 UTF-16 code units. Long code blocks are partial evidence,
not complete files. Very small windows may leave no space for older excerpts.

This policy is **lossy and language-biased**, not a semantic summary or perfect
recall mechanism. Essential facts belong in explicit task notes. The acceptance
test preserves a fixed set of pinned facts through a smaller-window handoff;
it does not prove arbitrary facts survive automatic excerpt selection. Full
originals remain in the transcript, and future larger models can use them again.
Rebuilding always starts from originals, preventing repeated-summary drift.

`/compact` enables early compaction, retaining at most two recent groups when
it actually reduces input. It does not enlarge already-small requests just to
create a summary. `/context` → R returns to full history when it fits; overflow
still triggers automatic compaction. There are no extra model or cloud calls.

## User controls and durable state

- `/context`: estimates, budget source, retained/excerpted/excluded IDs, excerpt
  text, and notes. L toggles the current-history preview and last saved record.
  B changes limits, D clears overrides, C compacts, R restores full history when
  possible, E edits notes, and arrows scroll. The preview excludes the unsent draft.
- `/memory`: edit session task notes, Ctrl+S to save and Esc to cancel. Empty
  saved text removes the active notes. Old context records retain historical
  note snapshots for audit; removal is not secure erasure. Notes are explicit
  user input, never automatically inferred or promoted from model replies.
- Notes and limit changes require an idle session; the current request keeps
  its original input and settings. Limits are scoped to provider/model within
  a session. New sessions start with empty notes and no limit overrides.

Schema v3 adds `context_state` and append-only `context_runs`. Each record includes
the algorithm version, provider/model, source references, excerpts, note snapshot,
and budget. Request context is saved before network activity. A record write
failure prevents the model call and blocks subsequent sends. Manual compaction
policy and its record commit atomically. Configured provider credentials are not
serialized into these records. User-written notes, like messages, can contain
sensitive text and are stored unencrypted in the local database.

Existing v1/v2 databases receive a SQLite-aware backup before migration, including
committed WAL pages. Live older owners block migration; close them and restart.
Neither messages, previous model switches, nor selections are discarded. Newer
schema versions remain rejected by older builds.

## Verification and remaining work

Tests exercise window/output accounting, Unicode, source offsets, coherent recent
turns, pinned-fact handoff, interruption, oversized input refusal, no extra model
requests, persisted notes/overrides, failed writes, atomic compaction, migrations,
and the actual terminal controls. The HTTP fixture tests the provider wire format.

Verification: 40 core tests and 33 CLI tests passed (73 total), along with type
checking and the Windows x64 build. In a compiled-executable smoke test using an
isolated data directory and local HTTP fixture, a 14,761-token conservative input
estimate became 1,205 against a 1,280 input budget. The request carried the
512-token reply cap and pinned facts, with no Ollama authorization header. All
26 original/new messages remained saved. Restart restored the notes, per-model
limits, and prior context record. No real provider inference was needed.

Still pending: model-generated summaries, exact model tokenizers, reported usage,
project/user memory scopes, imported/exported context, file/tool evidence and
its permission model, and broader real-model handoff evaluations. The product
remains a text conversation harness until coding tools ship.
