# Contributing

Use Bun 1.4.2 and run `bun install --frozen-lockfile`, `bun run test`, and
`bun run typecheck`. Launch development with `bun run dev:cli`. Tests use model
fixtures and isolated databases; they must not require provider keys or spend
credits. Never commit `.env`, credentials, local databases, or chat exports.

The UI is in packages/cli. Provider adapters, context building, canonical
messages, and persistence belong in packages/core; core must not import React.
Preserve original transcripts, transactional state changes, and explicit
provider boundaries. Include migrations and recovery tests for schema changes.

When changing a documented flow, update its [Excalidraw diagram](docs/diagrams/README.md)
and PNG export together. Diagram sources live beside their rendered images in
`docs/diagrams`; the README and implementation guides share the same exports.

Keep changes small and describe the user-visible problem and validation in
pull requests. Report bugs with OS, Bun version, NightOwl version, sanitized
reproduction steps, and expected/actual behavior. For security issues, see
SECURITY.md. Contributions use the repository's MIT license.
