/**
 * T32 adv4 P1-2：入口（API、manager）加校验之前写进 cron.json 的旧任务，prompt 里的控制字符到点照样会敲进 TUI——
 * 真 CC 上 \x1b[Z 被当成 Shift+Tab，把权限模式切掉。调度器发送前拒发、记 error；manager 的 cron-add / cron-edit 也拒。
 * 都在子进程里跑：临时 HOME，PATH 里的 tmux / bun 是假的并记调用，碰不到真实状态和 master.sock。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CRON_PROMPT_REFUSED, controlCharError } from "../src/lib/flag-like";
import { testChildEnv } from "./test-env.ts";

const SRC = join(import.meta.dir, "..", "src");
let home = "";
let env: Record<string, string> = {};
const log = (n: string) => (existsSync(join(home, n)) ? readFileSync(join(home, n), "utf8") : "");
const job = (id: string, prompt: string, targetAgent?: string) => ({
  id, name: id, schedule: "* * * * *", prompt, dir: "/tmp", enabled: true, createdAt: "2026-01-01T00:00:00Z", ...(targetAgent ? { targetAgent } : {}),
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "cron-refuse-"));
  const bin = join(home, "fakebin");
  mkdirSync(bin);
  mkdirSync(join(home, ".claude-orchestrator"));
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "tmux.log")}'\nexit 1\n`, { mode: 0o755 });
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "bun.log")}'\necho '{"ok":false}'\n`, { mode: 0o755 });
  env = testChildEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: home, CLAUDESTRA_RUNTIME_DIR: join(home, "rt"), CONTROL_CHANNEL_ID: "", LANG: "C" });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("调度器：存量任务的 prompt 带控制字符 → 拒发", () => {
  test("定向已有 agent / 临时 agent 两条路都不发，history 记 error，tmux 和 manager 一次都没调", () => {
    const script = join(home, "fire.ts");
    const jobs = [job("stored-esc", "定时汇报\u001b[Z", "cc"), job("stored-nl", "看日志\n/clear")];
    writeFileSync(script, `import { executeJob } from ${JSON.stringify(join(SRC, "cron.ts"))};\nfor (const j of ${JSON.stringify(jobs)}) await executeJob(j);\n`);
    const r = Bun.spawnSync([process.execPath, script], { env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const history = JSON.parse(log(".claude-orchestrator/cron-history.json")) as { jobName: string; status: string; error?: string }[];
    expect(history.map((h) => [h.jobName, h.status, h.error])).toEqual([
      ["stored-esc", "error", CRON_PROMPT_REFUSED],
      ["stored-nl", "error", CRON_PROMPT_REFUSED],
    ]);
    expect(log("tmux.log")).not.toContain("send-keys");
    expect(log("bun.log")).toBe(""); // 临时 agent 那条没去建 agent
  });
});

describe("manager：cron-add / cron-edit 拒控制字符（与 API 入口同一道）", () => {
  const manager = (...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, join(SRC, "manager.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString().trim().split("\n").pop() || "{}";
    return JSON.parse(out) as { ok: boolean; error?: string };
  };

  test("cron-add：prompt 带 \\x1b[Z / 换行 → 报错，cron.json 里没有", () => {
    expect(manager("cron-add", "m-esc", "* * * * *", "/tmp", "汇报\u001b[Z")).toEqual({ ok: false, error: controlCharError("prompt") });
    expect(manager("cron-add", "m-nl", "* * * * *", "/tmp", "a\nb")).toEqual({ ok: false, error: controlCharError("prompt") });
    expect(log(".claude-orchestrator/cron.json")).not.toContain("m-esc");
  });

  test("cron-edit：改成带控制字符的 prompt → 报错，原任务不变", () => {
    expect(manager("cron-add", "m-ok", "* * * * *", "/tmp", "每天汇总").ok).toBe(true);
    expect(manager("cron-edit", "m-ok", "--prompt", "汇总\u0003")).toEqual({ ok: false, error: controlCharError("prompt") });
    const saved = JSON.parse(log(".claude-orchestrator/cron.json")) as { name: string; prompt: string }[];
    expect(saved.find((j) => j.name === "m-ok")?.prompt).toBe("每天汇总");
  });
});
