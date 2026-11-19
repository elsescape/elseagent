<p align="center"><img src="assets/avatar.png" alt="elseagent" width="160"></p>

# elseagent

A [Codex](https://github.com/openai/codex) agent with a web chat and an HTTP API, and
optionally in Slack and Telegram. Ask it to work in a session, thread or DM, share files,
or run a task on a schedule.

[Install](#local-installation) · [User service](#run-as-a-user-service) · [Configuration](#configuration) · [Slack](#slack) ·
[Telegram](#telegram) · [Usage](#usage) · [Web chat](#web-chat) · [HTTP API](#http-api) ·
[Deployment](#deployment) · [Development](#development)

## Local installation

On macOS or Linux, install the [Codex CLI](https://github.com/openai/codex) and run:

```bash
brew install elsescape/tap/elseagent
elseagent init
```

Run `elseagent run` and open the [web chat](#web-chat) at `http://127.0.0.1:2923/`. To use
Slack or Telegram as well, uncomment `channels` in `~/.elseagent/config.yml` and fill in
the credentials.
Use `brew update && brew upgrade elseagent` to upgrade. Builds are also available from
[GitHub Releases](https://github.com/elsescape/elseagent/releases).

On startup, Codex uses an API key or a saved login. If neither is available, open
the device sign-in link from the logs and enter the code.

## Run as a user service

After configuring the local CLI, run these commands as the account that will run elseagent:

```bash
elseagent service install                      # uses ~/.elseagent/config.yml
elseagent service install -c /path/config.yaml  # use a different config
elseagent service status
elseagent service logs
elseagent service logs -f
elseagent service stop
elseagent service start
elseagent service restart
elseagent service uninstall
```

Installation starts the service immediately. On Linux, it enables the systemd user unit
and enables lingering for the current account so the service starts at boot before login.
The system's logind policy must allow the account to enable lingering. Uninstall leaves
lingering enabled because it applies to the whole account.

On macOS, install from a signed-in desktop session. The LaunchAgent starts at the user's
next login after a reboot. Its combined stdout and stderr are written to
`~/Library/Logs/elseagent/service.log`. On Linux, logs go to the journal.

The service saves the executable, config path, and current `PATH` at installation.
Run `service install` again if those paths change.

## Configuration

[.config.example.yaml](.config.example.yaml) lists every setting and doubles as the template
for `elseagent init`. As generated, the agent is reached through its [web chat](#web-chat)
and [HTTP API](#http-api) only. Slack and Telegram are optional: uncomment either
section under `channels`, or both.

- **Agent** · Set its instructions with `prompt`, its working directory with `workspace`
  (default `~/workspace`), and the time zone for schedules with `timezone` (default system
  time zone). The SQLite database and recovery state live in `stateDir` (default `~/.elseagent`).
- **Limits** · The defaults are 32 concurrent turns, 1,024 queued messages, a 30-minute turn
  timeout and a 7-day session idle limit. Adjust them in the example.
- **Codex** · Set `codex.path` if the binary is outside `PATH`. Model and reasoning effort
  use Codex defaults unless overridden. Local installs default to `workspace-write`. The
  Docker images set `ELSEAGENT_SANDBOX_MODE=danger-full-access`, giving Codex full access
  inside the container.

- **API** · The [HTTP API](#http-api) and its web chat listen on `127.0.0.1:2923`. Change
  `api.host` and `api.port`, set `api.token` to require a bearer token, or turn it off with
  `api.enabled: false`. A host other than loopback requires a token. `api.webui: false`
  keeps the API and drops the web chat.

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

The Slack tools can read channel history and thread replies where the bot is a member.
Private channels and DMs can only be read while answering a message there. To enable
public message search, add `search:read.public` from the manifest and reinstall the app.
Search uses the action token from a Slack DM or @mention, so it is unavailable on
scheduled runs or after the token expires.

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

- `general_schedule_create` takes an ISO 8601 timestamp with a UTC offset (`at`) or a recurring
  `cron`. Up to 50 active schedules are supported, with a 5-minute minimum recurrence.
  Overdue schedules run once after restart. A full queue records the occurrence as skipped.
- Other schedule tools are `general_schedule_list`, `general_schedule_delete` and `general_schedule_run_now`.
  A manual run preserves the next automatic occurrence.
- Built-in MCP tools also cover status (`general_status`, `general_usage`), queue and sessions
  (`general_list_queue`, `general_remove_queued`, `general_list_sessions`, `general_forget_session`, `general_cancel_turn`), and `general_cleanup` for idle sessions and their files. Cleanup can preview
  what will be deleted and preserves usage records. Users who can talk to the agent can ask
  it to use these tools.
- The Slack adapter exposes `slack_thread_follow`, `slack_read_channel`,
  `slack_read_thread`, `slack_search` and `slack_post`. Use `slack_post` for a separate
  message to a public channel the bot has joined, or to the current private conversation.
  A scheduled task can use it to post to multiple destinations when asked.
  In a Telegram private chat, `telegram_send`
  sends text or workspace files to an existing topic and `telegram_rename_topic`
  changes its title. These tools operate within the requesting user's chat.
  Other integrations can register groups such as `gmail_*` or `workspace_*`.

If Codex's event stream breaks, the runner can continue the saved session once within
the original timeout when no operation is awaiting a result. When a command, MCP call,
or file change may have taken effect, it records the uncertainty in `stateDir/recovery/`
for the next reply to reconcile. Turns interrupted by an agent restart are reported in chat.

### Shared memory and todos

Say “remember that release reports should be in Chinese” or “add a todo to check image tags
before the next release.” The agent can look these up from Slack or Telegram, across topics,
after `/new`, and after a restart. Records belong to the agent, so keep them suitable for
everyone who can talk to it.

- `memory_search` finds saved facts and preferences by keyword. `memory_get` reads a key,
  and `memory_upsert` and `memory_delete` write or remove it.
- `todo_create`, `todo_list`, and `todo_update` track work across sessions. The default list
  shows pending and in-progress items. Use a scheduled task when you want a reminder.

Records live in the agent's SQLite database, independent of Codex sessions. Updates use
the last-read version to prevent one turn from overwriting another's changes.

## Web chat

Open `http://127.0.0.1:2923/` while the agent runs. Sessions are listed on the left, and a
conversation shows the agent's commands, file changes and tool calls as it works, then its
reply. Each session is a conversation with its own Codex session, like a Slack thread. With
`api.token` set, the page asks for the token once and keeps it in the browser. It works on
a phone, and has light and dark themes that follow the system unless you pick one.

The page is built into the `elseagent` binary and uses the [HTTP API](#http-api) below.
Set `api.webui: false` to serve the API alone.

## HTTP API

`elseagent run` serves an API under `http://127.0.0.1:2923/api` for dashboards and chat UIs.
With `api.token` set, every request sends `Authorization: Bearer <token>`. The API sends no
CORS headers, so a browser UI on a different host or port needs a proxy; without a token,
requests from another origin are refused outright. Bodies and responses are JSON, and
errors are `{ "error": "..." }`.

Agent state, read-only:

| Endpoint                 | Returns                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `GET /api/status`        | Version, model, workspace, channels, uptime, limits, running turns, counts |
| `GET /api/queue`         | Messages waiting for a turn (`limit`)                                      |
| `GET /api/conversations` | Conversations of every channel and their Codex threads (`limit`)           |
| `GET /api/schedules`     | Scheduled tasks with their next and last runs                              |
| `GET /api/usage`         | Token usage (`days` or `since`/`until`, `groupBy` day, user, channel…)     |
| `GET /api/todos`         | Shared todos (`status` active, all, pending…; `limit`)                     |
| `GET /api/memories`      | Shared memories (`q` to search, `limit`)                                   |

Chat sessions, each a conversation with its own Codex session like a Slack thread:

| Endpoint                          | Does                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| `POST /api/sessions`              | Create a session; optional `title`                                   |
| `GET /api/sessions`               | List sessions with `status` idle, queued or running                  |
| `GET /api/sessions/:id`           | The session, its `history`, the `live` turn and a `cursor`           |
| `PATCH /api/sessions/:id`         | Rename it (`title`)                                                  |
| `DELETE /api/sessions/:id`        | Delete it; `409` while a turn is queued or running                   |
| `POST /api/sessions/:id/messages` | Send `text` (optional `user`); `202` with `messageId`, `429` if full |
| `POST /api/sessions/:id/stop`     | Stop the running turn                                                |
| `GET /api/sessions/:id/events`    | Stream the session's events (server-sent events)                     |

```bash
curl -X POST localhost:2923/api/sessions
curl -N localhost:2923/api/sessions/$ID/events &
curl -X POST localhost:2923/api/sessions/$ID/messages \
  -H 'content-type: application/json' -d '{"text": "What is in this workspace?"}'
```

Every event has a `type`, the `messageId` of the user message whose turn it belongs to,
and a time `at`. A turn produces them in this order:

| `type`         | Carries                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_message` | `text`, `user`                                                                                                                                                                                                            |
| `turn_started` |                                                                                                                                                                                                                           |
| `codex`        | `event`, a Codex SDK event as it is: `item.started`, `item.updated` and `item.completed` with reasoning, commands and their output, file changes, MCP tool calls and web searches, then `turn.completed` with token usage |
| `status`       | `text`, a one-line summary such as "is running `bun test`…"; empty clears it                                                                                                                                              |
| `reply`        | `text` (Markdown), `choices`, `files`                                                                                                                                                                                     |
| `turn_ended`   | `status` completed, failed or interrupted                                                                                                                                                                                 |

Codex's last `agent_message` item is the reply as JSON. Show the `reply` event instead: it is
that message parsed, or a notice from elseagent such as a timeout.

To show a session, load `GET /api/sessions/:id`, render `history` then `live`, and open the
stream with `?after=<cursor>` so nothing is missed or repeated. A stream that reconnects
with `Last-Event-ID` resumes where it stopped. Without either, a stream starts with the
turns in progress.

elseagent stores no transcripts. `history` is read back from Codex's own session files, so
it survives restarts, and it is gone once cleanup deletes a session's Codex threads.
Notices elseagent posted itself are not part of it. Live events are held in memory only
while their turn runs. Attachments are not supported over the API yet, and reply `files`
are paths on the agent's machine.

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
To reach the [HTTP API](#http-api) from outside the container, set `api.host: 0.0.0.0` with
an `api.token` and publish port 2923.

### Docker Compose

Copy `.config.example.yaml` to `config.yaml` next to [compose.yaml](compose.yaml). Uncomment
and fill in the channels you use, or open the API as described above to use the web chat.
Optionally add tool credentials to `.env`.

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
bun run build                 # dist/elseagent, web chat included
bun run db:generate           # After editing src/state/schema.ts
```

Run `bun run lint` to apply formatting and lint fixes. Core code is in
[src/agent](src/agent), channel adapters in [src/channels](src/channels), the MCP
server in [src/mcp](src/mcp), the HTTP API in [src/api](src/api), the web chat in
[src/web](src/web), and migrations in [drizzle](drizzle).

The web chat is React with Tailwind and [shadcn/ui](https://ui.shadcn.com) components
(copied into [src/web/components/ui](src/web/components/ui)). Bun bundles it: from source
through the plugin in [bunfig.toml](bunfig.toml), and into the binary through
[scripts/build.ts](scripts/build.ts), because `bun build --compile` on the command line
cannot run the Tailwind plugin.

To add a channel, implement [`Channel`](src/channels/types.ts) and register its factory
in [adapters.ts](src/channels/adapters.ts). Normalize incoming messages before handing
them to the agent. Use a distinct prefix for new chat IDs and keep the adapter's
`stateKey` stable so persisted queue entries and sessions remain reachable after restart.

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
