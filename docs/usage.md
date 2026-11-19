# Using the agent

## Running it

```bash
elseagent init                               # write a minimal ~/.elseagent/config.yml
elseagent init -o ./agents/reviewer.yaml -f  # somewhere else, overwriting
elseagent run                                # start with ~/.elseagent/config.yml
elseagent run -c ./config.yaml               # another config
elseagent run -c ./config.yaml --dry-run     # check config, codex and workspace, then exit
```

The agent works in `workspace` from the config (default `~/workspace`, created if missing).
Codex runs in agent mode: no approval prompts, allowed outside git repositories, and in Codex's
`workspace-write` sandbox, so on your machine commands can only write in the workspace. The
Docker images turn the sandbox off, since the container is the sandbox. The `codex` CLI must be
installed (on `PATH`, or set `codex.path`). Without `codex.apiKey` or a saved `codex login`,
the agent starts a device-code login and prints the link and code to its log.

## Conversations

Slack and Telegram ([slack.md](slack.md), [telegram.md](telegram.md)) work the same way. With both
configured, one agent answers in both, sharing its queue and limits.

- Each conversation (a Slack thread, a Telegram topic, a DM) maps to one Codex session.
  Follow-ups continue that session; Codex keeps the history. In Slack threads the agent is part
  of, follow-ups don't need a mention ([slack.md](slack.md#threads)).
- Codex gets built-in instructions for working in chat (ask instead of guessing, end the turn
  to wait for an answer, chat-friendly Markdown); `prompt` is added after them.
- When Codex needs a decision it can offer choices, shown as buttons. Clicking one sends the
  pick to the agent as the next message.
- Files and images sent to the agent (in the message, or earlier in a Slack thread) are saved
  under `attachments/<conversation>/` in the workspace, and Codex is told where they are; images
  are also shown to Codex as images. Files up to 100 MB (Telegram lets bots download up to 20 MB).
- The agent can send files back (a chart, a report, an export): it names them with its reply and
  they are uploaded after the text, up to 10 per reply and 100 MB each (50 MB on Telegram).
- A message sent while the agent works on the same conversation waits for that turn to end.
  `!stop` (Telegram: `/stop`) is the exception: it stops the running turn right away.
- At most `maxConcurrent` Codex turns run at once. Further messages wait in a queue (first
  come, first served, one turn at a time per conversation).
- The session mapping and the queue live in SQLite under `stateDir`, so queued messages
  survive a restart. Messages that were mid-turn during a restart are reported back, not rerun.
- Conversations idle for `sessionIdleDays` are forgotten; their next message starts fresh. Codex
  keeps their history on disk until a `cleanup`. A conversation whose Codex session is gone
  (deleted by cleanup, or by hand) also starts a new session, with the whole thread as context.

## Agent tools and scheduled tasks

elseagent serves its own MCP tools (on `127.0.0.1`, random port and token) and registers them
with every Codex turn, so the agent can inspect and manage itself when asked:

- `status`, `list_queue`, `list_sessions`: running turns, queued messages, sessions, limits.
- `cancel_turn`, `remove_queued`, `forget_session`: stop a running turn (its conversation is told
  who stopped it), drop a queued message, or start a conversation over.
- `schedule_create`, `schedule_list`, `schedule_delete`, `schedule_run_now`: recurring tasks.
- `usage`: Codex token usage over a period (default the last 7 days), by day, user, channel,
  conversation or schedule. Ask "how many tokens did we use this week, per person?".
- `cleanup`: for conversations idle more than 30 days (or as asked), delete their sessions, the
  Codex sessions Codex saved for them (`codex delete`) and their attachments. The agent counts
  first (a dry run) and asks before deleting. A cleaned-up conversation that becomes active again
  starts a new Codex session that reads the thread again. Usage records are kept.

Ask in plain words, e.g. "every weekday at 9am, check the CI dashboard and post a summary in
#ops". Each run announces that it is starting in a new conversation (a Slack message or Telegram
topic), then runs a new Codex session and posts the result in that thread. Failures produce a brief
notification; internal error details stay in the logs. Reply there to recover the same session.
Schedules use `timezone` unless they
set their own, run at most every 5 minutes, and are limited to 50 per agent. A run missed while
the agent was down happens once after it restarts.

Anyone who can talk to the agent can use these tools.

## Interrupted execution and recovery

Tool failures (such as a website timing out) remain tool results for Codex to handle.
The agent is instructed to checkpoint independent batch items and continue other items
when safe, rather than abandon the whole batch for one inaccessible source.

The runner separately detects broken event streams, including a stream ending without
`turn.completed`. It never silently discards malformed events. If the saved session is
available and no tool operation is awaiting a result, it attempts one continuation of
that same session within the original timeout. The continuation first reconciles saved
progress; it does not replay the original task prompt. A model-reported failure,
cancellation, timeout, or an operation with an unconfirmed result is not automatically
retried.

An unconfirmed command, MCP call or file change pauses automatic recovery. The runner
keeps the session and stores operation IDs/types in `stateDir/recovery/` (not tool
arguments or output). A reply in the failure thread receives reconciliation instructions
before continuing. A successful conversational reply alone does not clear an uncertain
operation. This is deliberately conservative: the generic runner cannot prove whether
an arbitrary external write happened. Detailed errors remain in logs, not chat messages.
