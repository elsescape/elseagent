import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import pkg from "../package.json";
import { startApp } from "./app.ts";
import { CONFIG_TEMPLATE, DEFAULT_CONFIG_PATH, expandHome, loadConfig } from "./config/index.ts";
import { registerService } from "./service.ts";

export function buildProgram(): Command {
  const program = new Command()
    .name("elseagent")
    .description("Codex agent with an HTTP API, for Slack and Telegram")
    .version(pkg.version ?? "0.0.0");

  program
    .command("run")
    .description("start the agent")
    .option("-c, --config <path>", "path to config file", DEFAULT_CONFIG_PATH)
    .option("--dry-run", "check config, codex and workspace, then exit without connecting")
    .action(async (opts: { config: string; dryRun?: boolean }) => {
      const configPath = resolve(expandHome(opts.config));
      const config = await loadConfig(configPath);
      await startApp(config, { configPath, dryRun: opts.dryRun });
    });

  program
    .command("init")
    .description("generate a minimal config file")
    .option("-o, --output <path>", "where to write the config", DEFAULT_CONFIG_PATH)
    .option("-f, --force", "overwrite an existing file", false)
    .action(async (opts: { output: string; force: boolean }) => {
      const out = resolve(expandHome(opts.output));
      if (!opts.force && (await Bun.file(out).exists())) {
        program.error(`${out} already exists. Use --force to overwrite.`);
      }
      await mkdir(dirname(out), { recursive: true });
      await Bun.write(out, CONFIG_TEMPLATE);
      console.log(`Wrote ${out}`);
      console.log(
        "It serves the HTTP API as it is. To use Slack or Telegram, uncomment " +
          "channels in it. Then run:",
      );
      const isDefault = out === resolve(expandHome(DEFAULT_CONFIG_PATH));
      console.log(`  elseagent run${isDefault ? "" : ` -c ${out}`}`);
    });

  registerService(program);
  return program;
}
