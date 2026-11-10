# Changelog

## 0.1.0-alpha.1 — 2026-11-11

First continuity alpha: local terminal chat with OpenRouter and Ollama, provider
switching within a saved conversation, SQLite persistence/recovery, explicit
task notes, and local context compaction. Includes a context inspector, portable
JSON export/import, session renaming, basic Markdown/code display, and a chat
layout that uses the available terminal width.

Windows x64 is the initial binary target. This release does not edit files, run
commands, provide Plan/Build agents, or use subscription/OAuth authentication.
Compaction is lossy and uses conservative estimates; pin essential task facts
in `/memory`. See README.md and docs for setup, privacy, and known limitations.
