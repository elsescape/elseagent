import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { z } from "zod";

/** Shown as-is in help; expanded with `expandHome` before use. */
export const DEFAULT_CONFIG_PATH = "~/.elseagent/config.yml";

const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
] as const satisfies readonly ModelReasoningEffort[];

/** Marker used by .config.example.yaml for values the user must fill in. */
export const PLACEHOLDER = "REPLACE-ME";

const requiredString = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, `${name} is required`)
    .refine(
      (v) => !v.includes(PLACEHOLDER),
      `${name} is still the placeholder; set the real value`,
    );

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const positiveInt = (name: string) =>
  z.int(`${name} must be a whole number`).positive(`${name} must be greater than 0`);

/** The agent itself: its role, workspace, limits and state. These are top-level options. */
const agentSchema = z.object({
  // The agent's role, passed to Codex as developer instructions. Empty = plain Codex session.
  prompt: z
    .string()
    .transform((s) => s.trim() || undefined)
    .optional(),
  // Codex turns (one `codex exec` each) running at the same time. Idle sessions don't count.
  maxConcurrent: positiveInt("maxConcurrent").default(32),
  // Messages waiting for a free slot; beyond this new messages are turned away.
  maxQueue: positiveInt("maxQueue").default(1024),
  // A turn running longer than this is aborted and its slot freed.
  turnTimeoutMinutes: positiveInt("turnTimeoutMinutes").default(30),
  // A conversation with no activity for this long is forgotten; its next message starts fresh.
  sessionIdleDays: positiveInt("sessionIdleDays").default(7),
  // The directory Codex works in (repositories, files). Created if missing. `~` is expanded;
  // relative paths resolve against the config file.
  workspace: z.string().trim().min(1).default("~/workspace"),
  // Where the agent keeps its SQLite state (session mapping, message queue). `~` is expanded;
  // relative paths resolve against the config file.
  stateDir: z.string().trim().min(1).default("~/.elseagent"),
  // Default time zone for scheduled tasks (IANA name). Defaults to the server's time zone.
  timezone: z
    .string()
    .trim()
    .refine(isTimezone, "timezone must be an IANA time zone, e.g. Asia/Shanghai")
    .default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
});

// Only what the user may override. Agent-mode behaviour (sandbox, approvals, git check)
// is fixed in src/codex.ts; everything else uses the Codex defaults.
export const SANDBOX_MODES = ["workspace-write", "danger-full-access"] as const;
/** Environment variable giving the default `codex.sandboxMode` (set in the Docker images). */
export const SANDBOX_MODE_ENV = "ELSEAGENT_SANDBOX_MODE";

const codexSchema = z.object({
  path: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  // workspace-write (default): commands may only write in the workspace, no network.
  // danger-full-access: no Codex sandbox; for containers, which are the sandbox. Without a value
  // here, ELSEAGENT_SANDBOX_MODE sets it (the Docker images set danger-full-access).
  sandboxMode: z.enum(SANDBOX_MODES).optional(),
  // OpenAI API key for Codex (CODEX_API_KEY). Without it: a saved `codex login`, else a
  // device-code login at startup.
  apiKey: z.string().trim().min(1).optional(),
});

const slackSchema = z.object(
  {
    botToken: requiredString("channels.slack.botToken"),
    appToken: requiredString("channels.slack.appToken"),
    // Public Slack channels to join at startup, by name (with or without #) or ID.
    join: z.array(z.string().trim().min(1)).default([]),
    // auto: in threads it is part of, the agent reads every reply and decides whether to answer.
    // mention: it only answers when mentioned.
    threadReplies: z.enum(["auto", "mention"]).default("auto"),
  },
  { error: "channels.slack must be a section with botToken and appToken" },
);

const USER_ID_ERROR = "channels.telegram.allowedUsers entries must be numeric Telegram user IDs";
const telegramUserId = z
  .union([z.int(USER_ID_ERROR), z.string().trim().regex(/^\d+$/, USER_ID_ERROR)], {
    error: USER_ID_ERROR,
  })
  .transform(String);

const telegramSchema = z.object(
  {
    botToken: requiredString("channels.telegram.botToken"),
    // Telegram user IDs that may talk to the agent; /start tells a user their ID.
    allowedUsers: z.array(telegramUserId).default([]),
  },
  { error: "channels.telegram must be a section with botToken" },
);

/** A section that may be left out; an empty one (`slack:` alone, parsed as null) too. */
const optionalSection = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => v ?? undefined, schema.optional());

const NO_CHANNEL = "configure at least one channel: channels.slack or channels.telegram (or both)";

// Where people talk to the agent: each channel is turned on by its section. At least one.
const channelsSchema = z.preprocess(
  (v) => v ?? {},
  z
    .object(
      {
        slack: optionalSection(slackSchema),
        telegram: optionalSection(telegramSchema),
      },
      { error: "channels must be a section with slack and/or telegram" },
    )
    .refine((c) => c.slack || c.telegram, { error: NO_CHANNEL }),
);

export const configSchema = agentSchema
  .extend({
    // Optional sections may be missing or empty (`codex:` with nothing under it parses as null).
    codex: z.preprocess((v) => v ?? {}, codexSchema),
    channels: channelsSchema,
  })
  // Unknown top-level keys are mistakes (a typo, or `env:`/`agent:`/`integrations:` from
  // older configs).
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ChannelsConfig = Config["channels"];
export type SlackConfig = NonNullable<ChannelsConfig["slack"]>;
export type TelegramConfig = NonNullable<ChannelsConfig["telegram"]>;
export type CodexConfig = Config["codex"];

/** Every config section; the example must include each field. */
export const configSections = {
  "": agentSchema, // top level
  codex: codexSchema,
  "channels.slack": slackSchema,
  "channels.telegram": telegramSchema,
};
