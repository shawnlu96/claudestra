/**
 * 起 api-route-parity.runner.ts 子进程的公共部分（claude-settings-runtime、session-gates 两个测试共用）：
 * 临时 HOME / 状态目录 / tmux socket 目录；PATH 里的 bun 是假的（充当 `manager`，回一份固定的 list 输出），
 * tmux 一律 exit 1。不碰真实 registry，也不碰 master.sock。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type RunnerResult = { name: string; status?: number; body?: string; threw?: string; message?: string };

export interface RunnerHome {
  /** 临时 HOME：测试可以往里放会话文件、归档 */
  home: string;
  run(specs: unknown[], env?: Record<string, string>): RunnerResult[];
  /** 假 manager 被调用时收到的参数，一次一行（没调过 → ""）：断言「被拒的请求没走到 manager」 */
  managerCalls(): string;
  cleanup(): void;
}

/** 假 `manager` 的输出由 registry 推出：一律 stopped，列表端点就不去 tmux 探忙；每次调用的参数记进 manager-calls.log */
export function runnerHome(prefix: string, registry: { agents: Record<string, unknown> }): RunnerHome {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const fakeBin = join(home, "fakebin");
  mkdirSync(fakeBin);
  mkdirSync(join(home, "rt"));
  const list = {
    ok: true,
    agents: Object.keys(registry.agents).map((name) => ({ name, channelId: `api:${name}`, status: "stopped", purpose: "" })),
  };
  const calls = join(home, "manager-calls.log");
  writeFileSync(join(fakeBin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\necho '${JSON.stringify(list)}'\n`, { mode: 0o755 });
  writeFileSync(join(fakeBin, "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  mkdirSync(join(home, ".claude-orchestrator"), { recursive: true });
  writeFileSync(join(home, ".claude-orchestrator", "registry.json"), JSON.stringify(registry));
  return {
    home,
    run(specs, env = {}) {
      const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "api-route-parity.runner.ts"), JSON.stringify(specs)], {
        env: {
          PATH: `${fakeBin}:/usr/bin:/bin`,
          HOME: home,
          TMPDIR: home,
          CLAUDESTRA_RUNTIME_DIR: join(home, "rt"),
          CONTROL_CHANNEL_ID: "",
          LANG: "C",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const lines = r.stdout.toString().trim().split("\n");
      if (r.exitCode !== 0 || !lines.length) throw new Error(`runner failed: ${r.stderr.toString().slice(-2000)}`);
      return JSON.parse(lines[lines.length - 1]);
    },
    managerCalls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : ""),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
