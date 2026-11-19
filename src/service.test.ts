import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

for (const platform of ["linux", "darwin"]) {
  test(`service lifecycle via ${platform}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "elseagent-service-"));
    try {
      const calls = join(home, "calls");
      const preload = join(home, "platform.ts");
      const config = join(home, "config & 100% $.yaml");
      await Bun.write(
        preload,
        `Object.defineProperty(process, "platform", { value: "${platform}" });`,
      );
      await Bun.write(config, "channels:\n  slack:\n    botToken: a\n    appToken: b\n");
      for (const name of ["systemctl", "loginctl", "journalctl", "launchctl", "tail"]) {
        const executable = join(home, name);
        await Bun.write(
          executable,
          `#!/bin/sh
printf '%s %s\n' "${name}" "$*" >> "$SERVICE_CALLS"
if [ "${name}" = launchctl ]; then
  case "$1" in
    bootstrap) touch "$HOME/loaded";;
    bootout) unlink "$HOME/loaded";;
    print) case "$2" in */com.elsescape.elseagent) test -f "$HOME/loaded";; esac;;
  esac
fi
`,
        );
        await chmod(executable, 0o755);
      }

      function run(...args: string[]) {
        return Bun.spawnSync(
          [
            process.execPath,
            "--preload",
            preload,
            join(import.meta.dir, "index.ts"),
            "service",
            ...args,
          ],
          {
            cwd: home,
            env: {
              ...process.env,
              HOME: home,
              PATH: `${home}:${process.env.PATH}`,
              SERVICE_CALLS: calls,
              XDG_CONFIG_HOME: join(home, "xdg"),
            },
          },
        );
      }

      function succeed(...args: string[]) {
        const result = run(...args);
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
      }

      succeed("install", "-c", "config & 100% $.yaml");
      const isLinux = platform === "linux";
      const definition = Bun.file(
        join(
          home,
          isLinux
            ? "xdg/systemd/user/elseagent.service"
            : "Library/LaunchAgents/com.elsescape.elseagent.plist",
        ),
      );
      const contents = await definition.text();
      expect(contents).toContain(isLinux ? 'ExecStart=:"' : "<key>RunAtLoad</key><true/>");
      expect(contents).toContain(isLinux ? "config & 100%% $.yaml" : "config &amp; 100% $.yaml");

      succeed("status");
      succeed("logs");
      succeed("logs", "-f");
      succeed("stop");
      succeed("start");
      succeed("restart");
      succeed("uninstall");
      succeed("uninstall");
      expect(await definition.exists()).toBe(false);

      const trace = (await Bun.file(calls).text()).split("\n");
      const uid = userInfo().uid;
      if (isLinux) {
        expect(trace).toContain(`loginctl enable-linger ${uid}`);
        for (const action of ["enable", "status", "stop", "start", "restart", "disable --now"]) {
          expect(trace).toContain(`systemctl --user --no-pager ${action} elseagent.service`);
        }
        expect(trace).toContain("journalctl --user-unit elseagent.service --no-pager -n 100");
        expect(trace).toContain("journalctl --user-unit elseagent.service --no-pager -n 100 -f");
      } else {
        const target = `gui/${uid}/com.elsescape.elseagent`;
        expect(trace).toContain(`launchctl enable ${target}`);
        expect(trace).toContain(`launchctl print ${target}`);
        expect(trace).toContain(`launchctl kickstart -k ${target}`);
        expect(trace.filter((line) => line === `launchctl bootout ${target}`)).toHaveLength(2);
        expect(
          trace.filter((line) => line.startsWith(`launchctl bootstrap gui/${uid} `)),
        ).toHaveLength(2);
        const log = join(home, "Library/Logs/elseagent/service.log");
        expect(trace).toContain(`tail -n 100 ${log}`);
        expect(trace).toContain(`tail -n 100 -F ${log}`);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
