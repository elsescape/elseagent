import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import { DEFAULT_CONFIG_PATH, expandHome, loadConfig } from "./config/index.ts";

const unit = "elseagent.service";
const label = "com.elsescape.elseagent";

type ServiceAction = "install" | "uninstall" | "status" | "logs" | "start" | "restart" | "stop";

function agentCommand(configPath: string): string[] {
  const entry = Bun.main;
  // Compiled Bun executables use a virtual entry point and can be run directly.
  const executable = entry.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, entry];
  return [...executable, "run", "--config", configPath];
}

async function writeDefinition(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function command(binary: string, args: string[], quiet = false) {
  const child = Bun.spawn([binary, ...args], {
    stdin: quiet ? "ignore" : "inherit",
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  const code = await child.exited;
  if (code !== 0 && !quiet) process.exitCode = code;
  return code === 0;
}

function systemdQuote(value: string) {
  return JSON.stringify(value.replaceAll("%", "%%"));
}

async function systemd(action: ServiceAction, configPath: string, follow: boolean) {
  const xdg = process.env.XDG_CONFIG_HOME;
  const path = join(
    xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"),
    "systemd/user",
    unit,
  );
  const ctl = (...args: string[]) => command("systemctl", ["--user", "--no-pager", ...args]);

  switch (action) {
    case "install": {
      await loadConfig(configPath);
      if (!(await ctl("show", "--property=Version"))) return;
      if (!(await command("loginctl", ["enable-linger", String(userInfo().uid)]))) return;
      const exec = agentCommand(configPath).map(systemdQuote).join(" ");
      const env = process.env.PATH
        ? `Environment=${systemdQuote(`PATH=${process.env.PATH}`)}\n`
        : "";
      await writeDefinition(
        path,
        `[Unit]\nDescription=elseagent\n\n[Service]\nExecStart=:${exec}\n${env}Restart=on-failure\nRestartSec=5s\n\n[Install]\nWantedBy=default.target\n`,
      );
      if ((await ctl("daemon-reload")) && (await ctl("enable", unit))) {
        await ctl("restart", unit);
      }
      break;
    }
    case "uninstall":
      if ((await Bun.file(path).exists()) && !(await ctl("disable", "--now", unit))) return;
      await rm(path, { force: true });
      await ctl("daemon-reload");
      break;
    case "logs":
      await command("journalctl", [
        "--user-unit",
        unit,
        "--no-pager",
        "-n",
        "100",
        ...(follow ? ["-f"] : []),
      ]);
      break;
    default:
      await ctl(action, unit);
  }
}

function plistString(value: string) {
  return `<string>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>`;
}

async function launchd(action: ServiceAction, configPath: string, follow: boolean) {
  const home = homedir();
  const path = join(home, "Library/LaunchAgents", `${label}.plist`);
  const log = join(home, "Library/Logs/elseagent", "service.log");
  const domain = `gui/${userInfo().uid}`;
  const target = `${domain}/${label}`;
  const ctl = (...args: string[]) => command("launchctl", args);
  const loaded = () => command("launchctl", ["print", target], true);
  const bootout = async () => {
    if (await loaded()) return ctl("bootout", target);
    // Distinguish a stopped service from an unavailable login session.
    return (await command("launchctl", ["print", domain], true)) || ctl("bootout", target);
  };

  switch (action) {
    case "install": {
      await loadConfig(configPath);
      if (!(await bootout())) return;
      await mkdir(dirname(log), { recursive: true, mode: 0o700 });
      await appendFile(log, "", { mode: 0o600 });
      const args = agentCommand(configPath).map(plistString).join("");
      const env = process.env.PATH
        ? `<key>EnvironmentVariables</key><dict><key>PATH</key>${plistString(process.env.PATH)}</dict>`
        : "";
      await writeDefinition(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${plistString(label)}
  <key>ProgramArguments</key><array>${args}</array>
  <key>WorkingDirectory</key>${plistString(home)}
  ${env}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${plistString(log)}
  <key>StandardErrorPath</key>${plistString(log)}
</dict>
</plist>
`,
      );
      if (await ctl("enable", target)) await ctl("bootstrap", domain, path);
      break;
    }
    case "uninstall":
      if (!(await Bun.file(path).exists())) return;
      if (await bootout()) await rm(path, { force: true });
      break;
    case "status":
      await ctl("print", target);
      break;
    case "logs":
      await command("tail", ["-n", "100", ...(follow ? ["-F"] : []), log]);
      break;
    case "start":
      if (!(await loaded())) await ctl("bootstrap", domain, path);
      break;
    case "restart":
      if (await loaded()) await ctl("kickstart", "-k", target);
      else await ctl("bootstrap", domain, path);
      break;
    case "stop":
      await bootout();
      break;
  }
}

export function registerService(program: Command) {
  const service = program
    .command("service")
    .description("manage the current user's background service");

  const descriptions = {
    install: "install, enable autostart and start the service",
    uninstall: "stop the service and remove its autostart registration",
    status: "show service status",
    logs: "show recent service logs",
    start: "start the service",
    restart: "restart the service",
    stop: "stop the service until started again or the next login/boot",
  } satisfies Record<ServiceAction, string>;

  for (const action of Object.keys(descriptions) as ServiceAction[]) {
    const subcommand = service.command(action).description(descriptions[action]);
    if (action === "install")
      subcommand.option("-c, --config <path>", "path to config file", DEFAULT_CONFIG_PATH);
    if (action === "logs") subcommand.option("-f, --follow", "follow new log output");

    subcommand.action(async (opts: { config?: string; follow?: boolean }) => {
      const backend = { linux: systemd, darwin: launchd }[process.platform as "linux" | "darwin"];
      if (!backend)
        subcommand.error("Service management requires Linux with systemd or macOS with launchd.");
      try {
        await backend(
          action,
          resolve(expandHome(opts.config ?? DEFAULT_CONFIG_PATH)),
          opts.follow ?? false,
        );
      } catch (error) {
        subcommand.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}
