# Slack

Each agent is its own Slack app, so it has its own name, avatar and tokens. The name lives in
Slack, not in the config.

## Setup

1. https://api.slack.com/apps > **Create New App** > **From a manifest**, paste
   [`slack-app-manifest.yaml`](../slack-app-manifest.yaml) and change both names to the agent's
   name.
2. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-`) into
   `channels.slack.botToken`.
3. **Basic Information > App-Level Tokens**: create a token with `connections:write`, copy it
   (`xapp-`) into `channels.slack.appToken`. Leave token rotation off: elseagent does not
   refresh it.
4. Optionally list public channels under `channels.slack.join`; the agent joins them at startup.
   Private channels need an `/invite @agent`.
5. Optionally set the app icon under **Basic Information > Display Information**, e.g.
   [`assets/avatar.png`](../assets/avatar.png) (1024 px; source:
   [`assets/avatar.svg`](../assets/avatar.svg)).

```yaml
channels:
  slack:
    botToken: xoxb-...
    appToken: xapp-...
    join: [ops]
```

All options: [config.md](config.md#channelsslack).

An app created from an older manifest lacks the file scopes: add `files:read` (read files
people attach) and `files:write` (send files) under **OAuth & Permissions > Bot Token Scopes**,
then reinstall the app. Without them the agent still works, but can't open or send files.
Likewise the stop button needs the `agent_session_stopped` bot event (**Event Subscriptions >
Subscribe to bot events**); without it Slack shows "Stop isn't available for this agent".
The app must also be declared an agent (`features.agent_view` and the `assistant:write` scope
in the manifest, or the **Agent** page in the app settings; switching from `assistant_view`
cannot be undone). After changing any of this, reinstall the app and hard-refresh Slack.

## In Slack

- The agent replies to `@mentions` in channels, in a thread, and to DMs.
- Each thread (or a DM's top level) is one conversation with its own Codex session. Each turn
  includes the thread messages posted since the agent last looked (the whole thread for a new
  session).
- Reactions on your message: ⏳ queued, 👀 working (removed when the reply is posted), ❌ failed.
- While Codex works, the bottom of the thread shows what it is doing ("is running `bun test`…").
- Attach files or images to your message (or post them in the thread before mentioning the
  agent): it reads them. It can attach files to its replies too.
- To stop what the agent is doing, click the stop button on "is working" (or send `!stop` in the
  thread). Messages you sent meanwhile are still handled after it.
- In a DM, the `/new` slash command starts the DM over with a new session. In channels, start a
  new thread instead.
- Scheduled tasks post their result as a new message only when the agent chooses to reply.
  Notifications start with ⏰ and the task name in bold on the first line, followed by the result or a brief error without internal details.
  Results over 1,200 characters or 12 lines show a short opening summary in the channel and the
  full result (including buttons and attachments) in its thread. Silent runs post nothing.
  Reply in the result or error thread to investigate or resume the same session.

## Threads

Once the agent is part of a thread (you mentioned it there, or it posted a scheduled result),
you don't need to mention it again: it reads every reply and decides whether to answer.

- Replies to the agent are answered: the person it just answered can simply reply.
- Other messages get a quiet look: no reactions, no status. The agent stays silent unless the
  message is meant for it or it can really help, so people can keep talking among themselves.
  Messages that mention someone else are left to them.
- A mention always gets an answer, and is handled first: it doesn't wait behind the agent's
  quiet look at earlier messages.
- To keep it out of a thread, say so ("stay out of this thread") or send `!mute`; it then only
  answers when mentioned. To bring it back, mention it ("follow this thread again") or send
  `!unmute`.
- It stops following on its own after about 100 messages without a reply from it, or 10 days
  without a mention.

To answer only when mentioned everywhere, set `channels.slack.threadReplies: mention`.

See [usage.md](usage.md) for what works the same on every channel.
