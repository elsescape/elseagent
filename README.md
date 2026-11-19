<p align="center"><img src="assets/avatar.png" alt="elseagent" width="160"></p>

# elseagent

A [Codex](https://github.com/openai/codex) agent for your Slack. Mention it in a thread or DM it:
it writes code, runs commands and can do tasks on a schedule. Telegram works too.

## Quick start

**1. Create the Slack app** from [`slack-app-manifest.yaml`](slack-app-manifest.yaml) and get its
two tokens: [docs/slack.md](docs/slack.md).

**2. Write `config.yaml`** next to [`compose.yaml`](compose.yaml):

```yaml
channels:
  slack:
    botToken: xoxb-...
    appToken: xapp-...
```

Optionally copy [`.env.example`](.env.example) to `.env` to sign in the tools the agent uses
(`GH_TOKEN` for GitHub, Cloudflare…), or sign in by hand later with
`docker compose exec elseagent bash`.

**3. Run it**:

```bash
docker compose up -d
docker compose logs -f   # first time: open the link, enter the code to sign in to Codex
```

Then mention `@elseagent` in a channel, or send it a DM.

**With Homebrew** on macOS or Linux:

```bash
brew install elsescape/tap/elseagent
elseagent init
```

Install the Codex CLI separately, fill in the Slack or Telegram settings in
`~/.elseagent.yaml`, then run `elseagent run`. Use `brew update && brew upgrade elseagent`
to update an existing Homebrew installation.

**On Kubernetes**: put the tokens in [`k8s/elseagent.yaml`](k8s/elseagent.yaml) (full image,
32 GB disk, 4 GB memory), then `kubectl apply -f k8s/elseagent.yaml` and
`kubectl logs -f elseagent-0` to sign in to Codex.

## More

- [Configuration](docs/config.md): the agent's role, limits, every option
- [Telegram](docs/telegram.md): use a Telegram bot instead of (or with) Slack
- [Usage](docs/usage.md): conversations, agent tools, scheduled tasks, running without Docker
- [Docker and Kubernetes](docs/docker.md): the images, tool credentials, volumes
- [Development](docs/development.md)
