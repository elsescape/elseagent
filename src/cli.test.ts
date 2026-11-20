import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_TEMPLATE } from "./config/index.ts";

const entry = join(import.meta.dir, "index.ts");

/**
 * Run the CLI with HOME pointed at the test directory, so ~/.elseagent/config.yml is isolated, and a
 * stand-in `codex` (logged in) first on PATH, so the real CLI is neither needed nor touched.
 */
function run(args: string[], cwd: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: cwd,
    PATH: `${fakeBin}:${process.env.PATH}`,
    CODEX_API_KEY: undefined,
  };
  const proc = Bun.spawnSync(["bun", entry, ...args], { cwd, env });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

let dir: string;
let fakeBin: string;
beforeAll(async () => {
  // realpath: on macOS the tmpdir is a symlink (/var -> /private/var) and the CLI prints real paths.
  dir = await realpath(await mkdtemp(join(tmpdir(), "elseagent-cli-")));
  fakeBin = await mkdtemp(join(tmpdir(), "elseagent-cli-bin-"));
  await Bun.write(join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n");
  await chmod(join(fakeBin, "codex"), 0o755);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
});

describe("cli", () => {
  test("without a command shows help listing run and init", () => {
    const res = run([], dir);
    const out = res.stdout + res.stderr;
    expect(out).toContain("Usage: elseagent");
    expect(out).toMatch(/run \[options\] +start the agent/);
    expect(out).toMatch(/init \[options\]/);
  });

  test("init writes ~/.elseagent/config.yml by default", async () => {
    const res = run(["init"], dir);
    expect(res.code).toBe(0);
    expect(await Bun.file(join(dir, ".elseagent", "config.yml")).text()).toBe(CONFIG_TEMPLATE);
    expect(res.stdout).toContain("  elseagent run\n");
  });

  test("run reads ~/.elseagent/config.yml by default", async () => {
    await Bun.write(
      join(dir, ".elseagent", "config.yml"),
      "channels:\n  slack:\n    botToken: a\n    appToken: b\n",
    );
    const res = run(["run", "--dry-run"], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`config: +${join(dir, ".elseagent", "config.yml")}\\n`));
    await Bun.write(join(dir, ".elseagent", "config.yml"), CONFIG_TEMPLATE);
  });

  test("-c and -o accept ~ paths", async () => {
    expect(run(["init", "-o", "~/sub/a.yaml"], dir).code).toBe(0);
    expect(await Bun.file(join(dir, "sub/a.yaml")).exists()).toBe(true);
  });

  test("init refuses to overwrite without --force", () => {
    const res = run(["init"], dir);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("already exists");
    expect(run(["init", "--force"], dir).code).toBe(0);
  });

  test("init -o creates parent directories", async () => {
    const out = join(dir, "nested", "a", "conf.yaml");
    expect(run(["init", "-o", out], dir).code).toBe(0);
    expect(await Bun.file(out).exists()).toBe(true);
  });

  test("the generated config is valid as it is", () => {
    const res = run(["run", "-c", "~/.elseagent/config.yml", "--dry-run"], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/channels: +\(none\)\n/);
    expect(res.stdout).toMatch(/api: +http:\/\/127\.0\.0\.1:2923\/api \(no token\)\n/);
  });

  test("run with -c reports validation errors", async () => {
    await Bun.write(
      join(dir, "placeholder.yaml"),
      "channels:\n  slack:\n    botToken: xoxb-REPLACE-ME\n    appToken: b\n",
    );
    const res = run(["run", "-c", "placeholder.yaml"], dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("channels.slack.botToken is still the placeholder");
  });

  test("run with a missing config points to init", () => {
    const res = run(["run", "-c", "missing.yaml"], dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("elseagent init");
  });

  test("run works in `workspace`, ~/workspace by default", async () => {
    await Bun.write(
      join(dir, "ok.yaml"),
      "channels:\n  slack:\n    botToken: a\n    appToken: b\n",
    );
    const res = run(["run", "-c", "ok.yaml", "--dry-run"], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`config: +${join(dir, "ok.yaml")}\\n`));
    // A dry run doesn't create it.
    expect(res.stdout).toMatch(
      new RegExp(`workspace: +${join(dir, "workspace")} \\(will be created\\)\\n`),
    );
  });

  test("run uses an existing `workspace`", async () => {
    await mkdir(join(dir, "ws"), { recursive: true });
    await Bun.write(
      join(dir, "ws.yaml"),
      "workspace: ws\nchannels:\n  slack:\n    botToken: a\n    appToken: b\n",
    );
    const res = run(["run", "-c", "ws.yaml", "--dry-run"], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`workspace: +${join(dir, "ws")}\\n`));
  });

  test("run rejects a `workspace` that is a file", async () => {
    await Bun.write(join(dir, "afile"), "x");
    await Bun.write(
      join(dir, "file.yaml"),
      "workspace: afile\nchannels:\n  slack:\n    botToken: a\n    appToken: b\n",
    );
    const res = run(["run", "-c", "file.yaml", "--dry-run"], dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("workspace is not a directory");
  });
});
