import type { ChannelsConfig } from "../config/index.ts";
import { createSlackBot } from "./slack/index.ts";
import { createTelegramBot } from "./telegram/index.ts";
import type { ConnectedChannel } from "./types.ts";

function adapter<K extends keyof ChannelsConfig>(
  name: K,
  create: (config: NonNullable<ChannelsConfig[K]>) => Promise<ConnectedChannel>,
) {
  return {
    name,
    enabled: (config: ChannelsConfig) => config[name] !== undefined,
    async connect(config: ChannelsConfig): Promise<ConnectedChannel | undefined> {
      const options = config[name];
      if (options !== undefined) return create(options);
    },
  };
}

// The first configured adapter supplies the database identity. Keep Slack first for existing
// agents that use both Slack and Telegram.
const adapters = [adapter("slack", createSlackBot), adapter("telegram", createTelegramBot)];

export function configuredChannelNames(config: ChannelsConfig): string[] {
  return adapters.filter((entry) => entry.enabled(config)).map((entry) => entry.name);
}

/** Connect the configured chat services (none, when the agent is only reached over its API). */
export async function connectChannels(
  config: ChannelsConfig,
  signal: AbortSignal,
): Promise<ConnectedChannel[]> {
  const connected: ConnectedChannel[] = [];
  for (const entry of adapters) {
    signal.throwIfAborted();
    const channel = await entry.connect(config);
    if (channel) connected.push(channel);
  }
  signal.throwIfAborted();
  return connected;
}
