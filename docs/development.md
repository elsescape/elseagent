# Development

| Command               | Description                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `bun install`         | Install dependencies                                                                                                       |
| `bun run start`       | Run locally during development                                                                                             |
| `bun run build`       | Compile to a single executable                                                                                             |
| `bun run typecheck`   | Type check (`bun check`)                                                                                                   |
| `bun run lint`        | Biome lint + format, applying fixes in place                                                                               |
| `bun test`            | Run tests                                                                                                                  |
| `bun run db:generate` | After changing `src/state/schema.ts`: generate a Drizzle migration into `drizzle/` (embedded into the build automatically) |

## Build and distribute

```bash
bun run build                            # dist/elseagent for the current platform
bun run build -- --target=bun-linux-x64  # cross-compile, e.g. for a Linux server
```

The output is a single self-contained executable. It does **not** include the `codex` CLI
(a ~380 MB native binary per platform), so the target machine needs `codex` installed
(e.g. `npm i -g @openai/codex`), either on `PATH` or referenced by `codex.path` in the config.

## Release to Homebrew

The [release workflow](../.github/workflows/release.yml) tests the tagged commit, builds
macOS and Linux archives for ARM64 and x64, and publishes them with SHA-256 checksums.
The tag supplies the version embedded in each executable. Stable releases also update
the `elseagent` formula in [elsescape/homebrew-tap](https://github.com/elsescape/homebrew-tap).

Set the repository Actions secret `HOMEBREW_TAP_TOKEN` to a token with Contents read/write
access to the tap. To replace the old Homebrew build, push a new stable version higher
than `v0.0.1` from this branch. Tags with a hyphen, such as `v0.1.0-rc.1`, publish only
a GitHub prerelease.

## Layout

- `src/channels/`: the chat channels. [`types.ts`](../src/channels/types.ts) is the interface
  every channel implements; `slack/` and `telegram/` implement it.
- `src/agent/`: the queue scheduler, Codex turns, schedules and the admin tools.
- `src/config/`: config schema and loading.
- `src/mcp/`: the elseagent MCP server.
- `src/state/`: the SQLite state (Drizzle).

## Config options

When adding an option, add it to [`src/config/schema.ts`](../src/config/schema.ts) and document
it in [`config.md`](config.md) (a test fails if an option is undocumented).
