import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONFIG_TEMPLATE,
  ConfigError,
  configSections,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  PLACEHOLDER,
} from "./index.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "elseagent-config-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, content);
  return path;
}

describe("loadConfig", () => {
  test("loads the template as it is: the API and web chat, no chat service", async () => {
    const config = await loadConfig(await writeConfig("template.yaml", CONFIG_TEMPLATE));
    expect(config.channels).toEqual({});
    expect(config.api).toEqual({ enabled: true, host: "127.0.0.1", port: 2923, webui: true });
    expect(config.maxConcurrent).toBe(32);
    expect(config.codex).toEqual({});
  });

  test("loads Slack once its section is uncommented and the tokens filled in", async () => {
    const filled = CONFIG_TEMPLATE.replace("# channels:", "channels:")
      .replace("#   slack:", "  slack:")
      .replace("#     botToken: xoxb-REPLACE-ME", "    botToken: xoxb-1")
      .replace("#     appToken: xapp-REPLACE-ME", "    appToken: xapp-1");
    const config = await loadConfig(await writeConfig("filled.yaml", filled));
    expect(config.channels).toEqual({
      slack: { botToken: "xoxb-1", appToken: "xapp-1", join: [], threadReplies: "auto" },
    });
  });

  test("rejects placeholder tokens with a clear message", async () => {
    const unfilled = CONFIG_TEMPLATE.replace("# channels:", "channels:")
      .replace("#   slack:", "  slack:")
      .replace("#     botToken:", "    botToken:")
      .replace("#     appToken:", "    appToken:");
    const err = await loadConfig(await writeConfig("unfilled.yaml", unfilled)).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("channels.slack.botToken is still the placeholder");
    expect(err.message).toContain("channels.slack.appToken is still the placeholder");
  });

  test("reports missing tokens and a missing channel", async () => {
    const empty = await writeConfig("empty-tokens.yaml", 'channels:\n  slack:\n    botToken: ""\n');
    const err = await loadConfig(empty).catch((e) => e);
    expect(err.message).toContain("channels.slack.botToken is required");
    expect(err.message).toContain("channels.slack.appToken is required");
    const off = "api:\n  enabled: false\n";
    const none = await writeConfig("no-channel.yaml", off);
    expect(loadConfig(none)).rejects.toThrow("configure at least one channel");
    const emptySection = await writeConfig("empty-slack.yaml", `${off}channels:\n  slack:\n`);
    expect(loadConfig(emptySection)).rejects.toThrow("configure at least one channel");
  });

  test("the api is on by default and is enough without a channel", async () => {
    const config = await loadConfig(await writeConfig("api-only.yaml", "maxConcurrent: 2\n"));
    expect(config.api).toEqual({ enabled: true, host: "127.0.0.1", port: 2923, webui: true });
    expect(config.channels).toEqual({});
  });

  test("the api needs a token to listen beyond this machine", async () => {
    const open = await writeConfig("api-open.yaml", "api:\n  host: 0.0.0.0\n");
    expect(loadConfig(open)).rejects.toThrow("api.token is required when api.host is not");
    const short = await writeConfig("api-short.yaml", "api:\n  token: secret\n");
    expect(loadConfig(short)).rejects.toThrow("api.token must be at least 16 characters");
    const port = await writeConfig("api-port.yaml", "api:\n  port: 70000\n");
    expect(loadConfig(port)).rejects.toThrow("api.port must be between 1 and 65535");
    const guarded = await writeConfig(
      "api-token.yaml",
      "api:\n  host: 0.0.0.0\n  port: 8080\n  token: 0123456789abcdef\n",
    );
    expect((await loadConfig(guarded)).api).toEqual({
      enabled: true,
      host: "0.0.0.0",
      port: 8080,
      token: "0123456789abcdef",
      webui: true,
    });
    const plain = await writeConfig("api-plain.yaml", "api:\n  webui: false\n");
    expect((await loadConfig(plain)).api.webui).toBe(false);
    // Off, it is not checked.
    const disabled = await writeConfig(
      "api-off.yaml",
      'api:\n  enabled: false\n  host: 0.0.0.0\nchannels:\n  telegram:\n    botToken: "1:a"\n',
    );
    expect((await loadConfig(disabled)).api.enabled).toBe(false);
  });

  test("telegram alone is enough; allowedUsers are kept as strings", async () => {
    const path = await writeConfig(
      "telegram.yaml",
      'channels:\n  telegram:\n    botToken: "123:abc"\n    allowedUsers: [42, "43"]\n',
    );
    const config = await loadConfig(path);
    expect(config.channels.slack).toBeUndefined();
    expect(config.channels.telegram).toEqual({ botToken: "123:abc", allowedUsers: ["42", "43"] });
    const bad = await writeConfig(
      "telegram-bad.yaml",
      "channels:\n  telegram:\n    botToken: x\n    allowedUsers: [alice]\n",
    );
    expect(loadConfig(bad)).rejects.toThrow("numeric Telegram user IDs");
  });

  test("slack and telegram together", async () => {
    const path = await writeConfig(
      "both.yaml",
      "channels:\n  slack:\n    botToken: a\n    appToken: b\n  telegram:\n    botToken: c\n",
    );
    const config = await loadConfig(path);
    expect(config.channels.slack?.botToken).toBe("a");
    expect(config.channels.telegram).toEqual({ botToken: "c", allowedUsers: [] });
  });

  test("prompt: multi-line is kept, empty means no prompt", async () => {
    const base = "channels:\n  slack:\n    botToken: a\n    appToken: b\n";
    const multi = await writeConfig("prompt.yaml", `prompt: |\n  Line one.\n  Line two.\n${base}`);
    expect((await loadConfig(multi)).prompt).toBe("Line one.\nLine two.");
    const empty = await writeConfig("empty-prompt.yaml", `prompt: "  "\n${base}`);
    expect((await loadConfig(empty)).prompt).toBeUndefined();
  });

  test("limits default and can be overridden", async () => {
    const base = "channels:\n  slack:\n    botToken: a\n    appToken: b\n";
    const defaults = await loadConfig(await writeConfig("limits-default.yaml", base));
    expect(defaults).toMatchObject({
      maxConcurrent: 32,
      maxQueue: 1024,
      turnTimeoutMinutes: 30,
      sessionIdleDays: 7,
      workspace: join(homedir(), "workspace"),
      stateDir: join(homedir(), ".elseagent"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const custom = await writeConfig(
      "limits.yaml",
      `maxConcurrent: 4\nsessionIdleDays: 1\n${base}`,
    );
    expect(await loadConfig(custom)).toMatchObject({
      maxConcurrent: 4,
      sessionIdleDays: 1,
    });
  });

  test("rejects non-positive or fractional limits", async () => {
    const base = "channels:\n  slack:\n    botToken: a\n    appToken: b\n";
    const zero = await writeConfig("zero.yaml", `maxConcurrent: 0\n${base}`);
    expect(loadConfig(zero)).rejects.toThrow("maxConcurrent must be greater than 0");
    const frac = await writeConfig("frac.yaml", `sessionIdleDays: 1.5\n${base}`);
    expect(loadConfig(frac)).rejects.toThrow("sessionIdleDays must be a whole number");
  });

  test("codex.sandboxMode: workspace-write unless the config or ELSEAGENT_SANDBOX_MODE says", async () => {
    const base = "channels:\n  slack:\n    botToken: a\n    appToken: b\n";
    const plain = await writeConfig("sandbox-default.yaml", base);
    expect((await loadConfig(plain, {})).codex.sandboxMode).toBeUndefined(); // workspace-write
    const env = { ELSEAGENT_SANDBOX_MODE: "danger-full-access" };
    expect((await loadConfig(plain, env)).codex.sandboxMode).toBe("danger-full-access");
    const set = await writeConfig(
      "sandbox-set.yaml",
      `codex:\n  sandboxMode: workspace-write\n${base}`,
    );
    expect((await loadConfig(set, env)).codex.sandboxMode).toBe("workspace-write");
    expect(loadConfig(plain, { ELSEAGENT_SANDBOX_MODE: "off" })).rejects.toThrow(
      "ELSEAGENT_SANDBOX_MODE must be one of",
    );
  });

  test("workspace expands ~ and resolves relative paths against the config file", async () => {
    const base = "channels:\n  slack:\n    botToken: a\n    appToken: b\n";
    const rel = await writeConfig("ws-rel.yaml", `workspace: ./ws\n${base}`);
    expect((await loadConfig(rel)).workspace).toBe(join(dirname(rel), "ws"));
    const home = await writeConfig("ws-home.yaml", `workspace: ~/code\n${base}`);
    expect((await loadConfig(home)).workspace).toBe(join(homedir(), "code"));
  });

  test("stateDir expands ~ and resolves relative paths against the config file", async () => {
    const base = "channels:\n  slack:\n    botToken: a\n    appToken: b\n";
    const home = await writeConfig("state-home.yaml", `stateDir: ~/agents/a\n${base}`);
    expect((await loadConfig(home)).stateDir).toBe(join(homedir(), "agents/a"));
    const rel = await writeConfig("state-rel.yaml", `stateDir: ./state\n${base}`);
    expect((await loadConfig(rel)).stateDir).toBe(join(dir, "state"));
  });

  test("unknown top-level keys are rejected (e.g. old env:/integrations: sections)", async () => {
    const base = "channels:\n  slack:\n    botToken: a\n    appToken: b\n";
    const old = await writeConfig("old-env.yaml", `${base}env:\n  GH_TOKEN: x\n`);
    expect(loadConfig(old)).rejects.toThrow('Unrecognized key: "env"');
    const integ = await writeConfig("old-int.yaml", `${base}integrations:\n  github: {}\n`);
    expect(loadConfig(integ)).rejects.toThrow('Unrecognized key: "integrations"');
  });

  test("codex section is optional", async () => {
    const path = await writeConfig(
      "min.yaml",
      "channels:\n  slack:\n    botToken: a\n    appToken: b\n",
    );
    expect((await loadConfig(path)).codex).toEqual({});
  });

  test("accepts model and reasoningEffort overrides", async () => {
    const path = await writeConfig(
      "override.yaml",
      "codex:\n  model: my-model\n  reasoningEffort: high\nchannels:\n  slack:\n    botToken: a\n    appToken: b\n",
    );
    expect((await loadConfig(path)).codex).toEqual({ model: "my-model", reasoningEffort: "high" });
  });

  test("resolves a relative codex.path against the config file", async () => {
    const path = await writeConfig(
      "rel.yaml",
      "codex:\n  path: ./bin/codex\nchannels:\n  slack:\n    botToken: a\n    appToken: b\n",
    );
    expect((await loadConfig(path)).codex.path).toBe(join(dir, "bin/codex"));
  });

  test("rejects an invalid reasoningEffort", async () => {
    const path = await writeConfig(
      "bad.yaml",
      "codex:\n  reasoningEffort: extreme\nchannels:\n  slack:\n    botToken: a\n    appToken: b\n",
    );
    expect(loadConfig(path)).rejects.toThrow("reasoningEffort");
  });

  test("reports a missing file", async () => {
    expect(loadConfig(join(dir, "nope.yaml"))).rejects.toThrow("Config file not found");
  });

  test("reports malformed YAML", async () => {
    const path = await writeConfig("broken.yaml", "channels: [unclosed\n");
    expect(loadConfig(path)).rejects.toThrow("Failed to parse");
  });
});

describe(".config.example.yaml", () => {
  test("is the template written by `elseagent init`", async () => {
    const example = await Bun.file(join(import.meta.dir, "../../.config.example.yaml")).text();
    expect(CONFIG_TEMPLATE).toBe(example);
    expect(example).toContain(DEFAULT_CONFIG_PATH);
  });

  test("only enables the local API and web chat by default", () => {
    expect(Bun.YAML.parse(CONFIG_TEMPLATE)).toEqual({
      api: { enabled: true, host: "127.0.0.1", port: 2923, webui: true },
    });
  });

  test("includes valid examples for every configurable field", async () => {
    const fullExample = CONFIG_TEMPLATE.replace(/^( *)# ( *[a-zA-Z][a-zA-Z0-9]*:)/gm, "$1$2");
    const example = Bun.YAML.parse(fullExample) as Record<string, unknown>;
    const sections = {
      "": example,
      codex: example.codex,
      "channels.slack": (example.channels as Record<string, unknown>).slack,
      "channels.telegram": (example.channels as Record<string, unknown>).telegram,
      api: example.api,
    };
    for (const [section, schema] of Object.entries(configSections)) {
      const sample = sections[section as keyof typeof sections] as Record<string, unknown>;
      expect(Object.keys(sample)).toEqual(expect.arrayContaining(Object.keys(schema.shape)));
    }
    const path = await writeConfig("all-settings.yaml", fullExample.replaceAll(PLACEHOLDER, "123"));
    const config = await loadConfig(path);
    expect(config.channels.telegram?.allowedUsers).toEqual(["123456789"]);
    expect(config.channels.slack?.join).toEqual(["ops"]);
    expect(config.api.token).toBe("123-long-random-secret");
  });
});
