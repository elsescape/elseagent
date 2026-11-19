# Codex SDK event framing

`@openai/codex-sdk@0.169.0` uses `readline` to frame JSONL events from the Codex CLI.
Under Bun 1.4.4, that reader also splits at U+2028 and U+2029. These characters are
legal inside JSON strings and occur in fetched webpage text, so a successful tool
result can become two invalid events and stop the whole turn.

The Bun dependency patch reads stdout with a streaming UTF-8 decoder and splits
only at LF, preserving Unicode characters and chunk boundaries. CRLF is accepted
by JSON.parse as trailing whitespace. Truly malformed events and nonzero process
exits still fail visibly; the patch does not discard events or rerun writes.

The patch also handles child-process pipe errors as turn failures. On cancellation, Codex
gets five seconds to exit before the SDK sends SIGKILL.

Bun applies the patch on install, before the SDK is bundled into the executable.
The Docker build copies this directory before its frozen install. When upgrading
the SDK, check whether the upstream reader is fixed and remove or rebase the patch.
`src/codex-stream.test.ts` tests the real SDK/subprocess boundary without using a
model, network access or the production database.
