/**
 * T73 r1：沙箱里 CODEX_HOME 缺失时，逐个调所有「定位 Codex 会话」的入口，都必须拒绝（抛 / null / [] / {error}），
 * 且一个字节都不从宿主 ~/.codex 拿。假宿主 HOME 下放两份带 HOSTMARK 的 rollout（主会话含额度事件、子线程且早已闲置）：
 * 任一入口回落到宿主根，输出里就会出现 HOSTMARK / 宿主路径，或宿主文件被清扫挪走——这条测试就红。全部假目录。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxEnv, sandboxLayout } from "../src/lib/sandbox-env.js";
import { testChildEnv } from "./test-env.js";

const tmp = mkdtempSync(join(tmpdir(), "sbx-codex-entries-"));
const hostHome = join(tmp, "host-home");
const root = join(tmp, "sbx");
const layout = sandboxLayout(root);
const MAIN = "019a7373-0000-7000-8000-00000000a001";
const SUB = "019a7373-0000-7000-8000-00000000b002";
const OLD = Date.parse("2026-08-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const dayDir = join(hostHome, ".codex", "sessions", "2026", "08", "01");
const hostMain = join(dayDir, `rollout-2026-08-01T00-00-00-${MAIN}.jsonl`);
const hostSub = join(dayDir, `rollout-2026-08-01T00-00-01-${SUB}.jsonl`);
const RL = { limit_id: "codex", primary: { used_percent: 42, window_minutes: 300, resets_at: 1790523470 }, secondary: null };

for (const d of [layout.stateDir, layout.runtimeDir, join(root, "work"), dayDir]) mkdirSync(d, { recursive: true });
writeFileSync(hostMain, [
  { timestamp: iso(OLD), type: "session_meta", payload: { id: MAIN, session_id: MAIN, cwd: "/HOSTMARK/main" } },
  { timestamp: iso(OLD), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: RL } },
].map((l) => JSON.stringify(l)).join("\n") + "\n");
writeFileSync(hostSub, JSON.stringify({
  timestamp: iso(OLD), type: "session_meta",
  payload: { id: SUB, session_id: MAIN, parent_thread_id: "parent-HOSTMARK", thread_source: "subagent", agent_nickname: "nick-HOSTMARK", cwd: "/HOSTMARK/sub" },
}) + "\n");
for (const f of [hostMain, hostSub]) utimesSync(f, OLD / 1000, OLD / 1000); // 闲置很久：清扫若回落宿主根就会把子线程挪走

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const src = (p: string) => JSON.stringify(join(import.meta.dir, "..", "src", p));
const SCRIPT = `
const { findLatestCodexQuota } = await import(${src("lib/codex-usage.ts")});
const { codexSource } = await import(${src("lib/runtimes/codex-source.ts")});
const { codexSessionCwdSync } = await import(${src("lib/runtimes/codex-deps.ts")});
const { sweepIdleCodexSubSessions } = await import(${src("lib/unmanaged-archive.ts")});
const { refuseUnconfirmedSubSession } = await import(${src("bridge/subsession-guard.ts")});
const { locateSessionFile } = await import(${src("bridge/session-file.ts")});
const { pickCodexRolloutForArchive } = await import(${src("lib/codex-rollout-pick.ts")});
const { MAIN, SUB, sweepDir } = JSON.parse(process.argv.at(-1));
const out = {};
const run = async (name, fn) => {
  try {
    let v = await fn();
    if (v instanceof Response) v = { status: v.status, body: await v.text() };
    out[name] = { value: v ?? null };
  } catch (e) {
    out[name] = { threw: String(e?.message ?? e) };
  }
};
await run("quota", () => findLatestCodexQuota());
await run("scan", () => codexSource.scanSessions());
await run("findById", () => codexSource.findSessionById(MAIN));
await run("cwdSync", () => codexSessionCwdSync(MAIN));
await run("sweep", () => sweepIdleCodexSubSessions({ keep: new Set(), idleDays: 1, archiveRoot: sweepDir, restoredIndex: sweepDir + "/restored.json" }));
await run("subGuard", () => refuseUnconfirmedSubSession({}, SUB, "codex"));
await run("history", () => locateSessionFile(MAIN, "claude-code", undefined));
await run("archivePick", () => pickCodexRolloutForArchive(MAIN, "/HOSTMARK/main"));
console.log(JSON.stringify(out));
`;

describe("沙箱缺 CODEX_HOME：每个 Codex 定位入口都拒绝，且不读宿主 ~/.codex", () => {
  const env = sandboxEnv({ PATH: process.env.PATH, HOME: hostHome, TMPDIR: process.env.TMPDIR }, {
    layout, port: 25174, deny: { ports: [3847], dirs: [join(hostHome, ".claude-orchestrator")] },
  });
  delete (env as Record<string, string | undefined>).CODEX_HOME;
  const r = Bun.spawnSync([process.execPath, "-e", SCRIPT, JSON.stringify({ MAIN, SUB, sweepDir: join(root, "sweep") })], {
    env: testChildEnv(env), cwd: root,
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  const out: Record<string, { value?: unknown; threw?: string }> = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);

  const expected: Array<[string, (o: { value?: unknown; threw?: string }) => void]> = [
    ["quota", (o) => expect(o.threw).toContain("CODEX_HOME")], // 调用方 latestQuotaCached 会 catch
    ["scan", (o) => expect(o.value).toEqual([])], // 列表类：跳过 Codex
    ["findById", (o) => expect(o.value).toBeNull()],
    ["cwdSync", (o) => expect(o.threw).toContain("CODEX_HOME")],
    ["sweep", (o) => expect(o.threw).toContain("CODEX_HOME")], // 调用方 sweepCodexSubsIfEnabled 有 try/catch
    ["subGuard", (o) => expect(o.value).toBeNull()], // 读不到就放行，不带宿主的 parentId / 昵称回 409
    ["history", (o) => expect(o.value).toBeNull()], // Claude Code 会话的 history 兜底查 Codex 时不 500
    ["archivePick", (o) => expect((o.value as { error?: string }).error).toContain("CODEX_HOME")],
  ];
  test.each(expected)("%s", (name, check) => {
    const o = out[name]!;
    expect(JSON.stringify(o)).not.toContain("HOSTMARK");
    expect(JSON.stringify(o)).not.toContain(hostHome);
    check(o);
  });

  test("宿主的两份 rollout 原地未动（清扫没把闲置子线程挪走）", () => {
    expect(existsSync(hostMain)).toBe(true);
    expect(existsSync(hostSub)).toBe(true);
    expect(existsSync(join(root, "sweep"))).toBe(false);
  });
});
