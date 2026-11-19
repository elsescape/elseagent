<p align="center"><img src="assets/avatar.png" alt="elseagent" width="160"></p>

# elseagent

A [Codex](https://github.com/openai/codex) agent for Slack and Telegram. Ask it to work
in a thread or DM, share files, or run a task on a schedule.

[Install](#local-installation) · [Configuration](#configuration) · [Slack](#slack) ·
[Telegram](#telegram) · [Usage](#usage) · [Deployment](#deployment) · [Development](#development)

## Local installation

On macOS or Linux, install the [Codex CLI](https://github.com/openai/codex) and run:

```bash
brew install elsescape/tap/elseagent
elseagent init
```

Fill in the channel credentials in `~/.elseagent/config.yml`, then run `elseagent run`.
Use `brew update && brew upgrade elseagent` to upgrade. Builds are also available from
[GitHub Releases](https://github.com/elsescape/elseagent/releases).

On startup, Codex uses an API key or a saved login. If neither is available, open
the device sign-in link from the logs and enter the code.

## Configuration

[.config.example.yaml](.config.example.yaml) lists every setting and doubles as the template
for `elseagent init`. Fill in Slack, uncomment Telegram, or configure both. For Telegram
alone, remove the Slack section.

- **Agent** · Set its instructions with `prompt`, its working directory with `workspace`
  (default `~/workspace`), and the time zone for schedules with `timezone` (default system
  time zone). The SQLite database and recovery state live in `stateDir` (default `~/.elseagent`).
- **Limits** · The defaults are 32 concurrent turns, 1,024 queued messages, a 30-minute turn
  timeout and a 7-day session idle limit. Adjust them in the example.
- **Codex** · Set `codex.path` if the binary is outside `PATH`. Model and reasoning effort
  use Codex defaults unless overridden. Local installs default to `workspace-write`. The
  Docker images set `ELSEAGENT_SANDBOX_MODE=danger-full-access`, giving Codex full access
  inside the container.

Use `elseagent init -o ./config.yaml` to write elsewhere and `-f` to overwrite. Use
`elseagent run -c ./config.yaml` to select a file and `--dry-run` to check the config and
Codex setup without connecting. Config-relative paths are resolved from the file's directory.
For a legacy config at `~/.elseagent.yaml`, pass that path with `-c` or move it and update
any relative paths. Keep files containing channel tokens private.

## Slack

1. Create an app **From a manifest** and use [slack-app-manifest.yaml](slack-app-manifest.yaml).
   Set the app and bot names, then install it in your workspace.
2. Copy the Bot User OAuth Token (`xoxb-…`) to `channels.slack.botToken`. Create an app-level
   token with `connections:write` and copy it to `channels.slack.appToken` (`xapp-…`).
   Leave token rotation disabled. You can set [assets/avatar.png](assets/avatar.png) as the app icon.
3. DM the bot or mention it in a channel. Use `channels.slack.join` for public channels it
   should join at startup and `/invite @agent` for private ones.

Follow-up messages in a thread can reach the agent without another mention. Use `!mute`
or `!unmute` for a thread, or set `channels.slack.threadReplies: mention` globally. The
native Stop button or `!stop` aborts the active turn. Use `/new` in a DM to start over.

For an existing app, sync the manifest's file scopes (`files:read`, `files:write`) and
Stop settings (`agent_view`, `assistant:write`, `agent_session_stopped`), then reinstall
the app and refresh Slack. Switching from `assistant_view` to `agent_view` is irreversible.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and set
   `channels.telegram.botToken`. Enable threaded mode for private chats if you want each
   topic to have a separate Codex session.
2. Start the agent and send `/start` to the bot to get your Telegram user ID. Add it to
   `channels.telegram.allowedUsers` and restart. The allowlist controls access to private chats.
3. Use `/stop` to stop the active turn, or `/new` to reset the current topic's session.

## Usage

Each conversation has its own Codex session. Messages in a busy conversation queue in
SQLite, and pending messages survive restarts. Send files or images alongside a request,
or ask the agent to attach a result. Choices appear as buttons. Attachments are saved
under `attachments/<conversation>/` in the workspace. Incoming files are limited to
100 MB on Slack and 20 MB on Telegram, and outgoing files to 100 MB and 50 MB respectively.

Ask for one-time or recurring work in plain language. For example, “remind me tomorrow at
3pm” or “check every 10 minutes and alert me only if there is an error.” A successful
error-only check with no findings stays silent. Posted results open a Slack thread or
Telegram topic you can follow up in. A failed check produces a brief notification.

- `schedule_create` takes an ISO 8601 timestamp with a UTC offset (`at`) or a recurring
  `cron`. Up to 50 active schedules are supported, with a 5-minute minimum recurrence.
  Overdue schedules run once after restart. A full queue records the occurrence as skipped.
- Other schedule tools are `schedule_list`, `schedule_delete` and `schedule_run_now`.
  A manual run preserves the next automatic occurrence.
- Built-in MCP tools also cover status (`status`, `usage`), queue and sessions
  (`list_queue`, `remove_queued`, `list_sessions`, `forget_session`, `cancel_turn`,
  `thread_follow`), and `cleanup` for idle sessions and their files. Cleanup can preview
  what will be deleted and preserves usage records. Users who can talk to the agent can ask
  it to use these tools.

If Codex's event stream breaks, the runner can continue the saved session once within
the original timeout when no operation is awaiting a result. When a command, MCP call,
or file change may have taken effect, it records the uncertainty in `stateDir/recovery/`
for the next reply to reconcile. Turns interrupted by an agent restart are reported in chat.

## Deployment

| Image                                     | Included                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ghcr.io/elsescape/elseagent-base:latest` | CLI tooling for code, GitHub, cloud, databases and media                                     |
| `ghcr.io/elsescape/elseagent-full:latest` | Base plus Chromium, LibreOffice, pandoc, PDF tools, fonts, ClickHouse client/server and chDB |

Both images support Linux amd64 and arm64. `latest` follows the latest stable GitHub
release, which also publishes a version tag such as `v0.1.0`. Use `head` for builds
from pushes to `main`. See the [Dockerfile](Dockerfile) for the tool
inventory and pinned versions. Build locally with `docker build --target full -t elseagent:full .`
or select the `base` target.

Both deployments mount the agent config at `/etc/elseagent/config.yaml` and persist
`/home/elseagent` (workspace, Codex login and sessions, SQLite state, user-installed tools).
Use [.env.example](.env.example) for optional tool credentials such as `GH_TOKEN`.
The default container time zone is Asia/Singapore. Set `timezone` to change the default for schedules.

### Docker Compose

Copy `.config.example.yaml` to `config.yaml` next to [compose.yaml](compose.yaml) and fill
in your channel settings. Optionally add tool credentials to `.env`.

```bash
docker compose up -d
docker compose logs -f
docker compose pull && docker compose up -d  # Update
```

Use `docker compose exec elseagent bash` for interactive tool setup. Give each agent its
own config and Compose project if you run multiple agents.

### Kubernetes

Fill in the config Secret in [k8s.yaml](k8s.yaml) and put optional tool credentials in
`elseagent-env`. The manifest uses the full image, a 32 GiB home volume, and 4 GiB memory.
Keep one StatefulSet replica per bot to avoid duplicate listeners and SQLite writers.

```bash
kubectl apply -f k8s.yaml
kubectl logs -f elseagent-0
kubectl rollout restart statefulset/elseagent  # After editing Secrets or to pull latest
```

## Development

```bash
bun install --frozen-lockfile
bun run start -- --help
bun run typecheck
bun test
bun run build                 # dist/elseagent
bun run db:generate           # After editing src/state/schema.ts
```

Run `bun run lint` to apply formatting and lint fixes. Core code is in
[src/agent](src/agent), channel adapters in [src/channels](src/channels), the MCP
server in [src/mcp](src/mcp), and migrations in [drizzle](drizzle).

Push a version tag to run the [release workflow](.github/workflows/release.yml). It tests
the tagged code and builds macOS and Linux archives for ARM64 and x64. Stable tags update the
[Homebrew tap](https://github.com/elsescape/homebrew-tap) using `HOMEBREW_TAP_TOKEN`, a
repository Actions secret with Contents read/write access to the tap. Tags with a hyphen
publish a GitHub prerelease.

### Codex SDK patch

Bun applies the [SDK patch](patches/@openai%252Fcodex-sdk@0.169.0.patch) at install time.
It uses `codex exec --json`, frames JSONL at LF so Bun preserves Unicode line separators
in JSON strings, and isolates subprocess pipe failures. Cancellation escalates to
`SIGKILL` after five seconds. When upgrading the SDK, check which fixes are upstream
and run `bun test src/codex-stream.test.ts` before removing or rebasing the patch.
