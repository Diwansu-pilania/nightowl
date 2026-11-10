# Security and privacy

Report vulnerabilities privately using the repository's GitHub security advisory
channel when enabled, or contact the repository owner before posting details.
Do not include API keys, credentials files, private transcripts, or export files
in public issues. The supported version is the latest 0.1 alpha.

NightOwl saves chat text, notes, errors, and context records locally without
encryption. Optional OpenRouter credentials are stored in a separate unencrypted
file only when explicitly saved. Export files contain transcript text and current
task notes, including any sensitive content the user or model wrote; configured
keys, endpoints, permissions, and local paths are not exported as configuration.

Ollama-only use makes no background cloud calls. Selecting OpenRouter sends the
chosen conversation context there on the next message. Credentials only go to
the fixed OpenRouter origin; redirects are disabled. The app has no telemetry,
automatic updates, model downloads, file editing, shell tools, or imported code
execution. Markdown is displayed as text; remote images are not fetched.

The Windows binary is unsigned. Compare its SHA-256 with the release checksum
and obtain releases from this repository. A checksum alone does not authenticate
the publisher. Build from the tagged source if you prefer.
