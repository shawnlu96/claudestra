/**
 * wake-cost 命令（src/manager/wake-cost.ts）：参数、unsupported / unknown、只读（会话字节与状态目录不变）、显式周汇总幂等。
 * 只用临时目录里的合成会话。
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseWakeCostArgs, runWakeCost, type WakeCostDeps } from "../src/manager/wake-cost.js";

const root = mkdtempSync(join(tmpdir(), "wake-cost-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sessionPath = join(root, "sess.jsonl");
const stateDir = join(root, "state");
const weekStart = Date.parse("2026-10-05T06:00:00Z");
const recs = [
  { type: "user", timestamp: "2026-10-06T00:00:00Z", message: { content: '<channel trigger="user_discord" user="o" user_id="1">\nzqxbody\n</channel>' } },
  {
    type: "assistant", timestamp: "2026-10-06T00:00:01Z", requestId: "q",
    message: { id: "a1", usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } },
  },
];
writeFileSync(sessionPath, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");

const deps = (runtime?: string): WakeCostDeps => ({
  agents: async () => ({ "agent-pm": { cwd: "/x", sessionId: "0123456789abcdef", runtime } }),
  window: () => ({ dayStart: weekStart, weekStart, weekSource: "quota" }),
  stateDir,
  resolvePath: () => sessionPath,
});

const listing = (dir: string): string[] => {
  try { return readdirSync(dir, { recursive: true }).map(String).sort(); } catch { return []; }
};

describe("wake-cost 命令", () => {
  test("参数：--agent 必填；--since 认 ISO 与 ms；--write-weekly 只配周窗口", () => {
    expect("error" in parseWakeCostArgs([])).toBe(true);
    expect(parseWakeCostArgs(["--agent", "a", "--since", "1000"])).toMatchObject({ period: "since", since: 1000 });
    expect(parseWakeCostArgs(["--agent", "a", "--write-weekly"])).toMatchObject({ period: "week", writeWeekly: true });
    expect("error" in parseWakeCostArgs(["--agent", "a", "--today", "--write-weekly"])).toBe(true);
  });

  test("非 Claude Code 运行时 → unsupported；找不到会话 → unknown；不在 registry → ok:false", async () => {
    expect((await runWakeCost(["--agent", "agent-pm", "--json"], deps("codex"))).json).toMatchObject({ status: "unsupported" });
    const noFile = { ...deps(), resolvePath: () => join(root, "missing.jsonl") };
    expect((await runWakeCost(["--agent", "agent-pm"], noFile)).json).toMatchObject({ status: "unknown" });
    expect((await runWakeCost(["--agent", "nobody"], deps())).json.ok).toBe(false);
  });

  test("[验收线 4] 默认只读：会话字节与状态目录文件清单前后一致", async () => {
    const bytes = readFileSync(sessionPath);
    const before = listing(root);
    const res = await runWakeCost(["--agent", "agent-pm", "--week", "--json"], deps());
    expect(res.json).toMatchObject({ status: "ok", window: { source: "week:quota" }, coverage: { session: "01234567" }, totals: { contextTotal: 6, requests: 1 } });
    await runWakeCost(["--agent", "agent-pm"], deps());
    expect(readFileSync(sessionPath).equals(bytes)).toBe(true);
    expect(listing(root)).toEqual(before);
  });

  test("[验收线 5] 显式写周报两次只产生同一个无正文汇总文件", async () => {
    const a = await runWakeCost(["--agent", "agent-pm", "--write-weekly"], deps());
    const first = readFileSync(String(a.json.weeklyFile), "utf-8");
    const b = await runWakeCost(["--agent", "agent-pm", "--week", "--write-weekly", "--json"], deps());
    expect(b.json.weeklyFile).toBe(a.json.weeklyFile);
    expect(listing(join(stateDir, "wake-cost"))).toEqual(["2026-10-05T06-00-00.000Z.json"]);
    const second = readFileSync(String(b.json.weeklyFile), "utf-8");
    expect(second).toBe(first);
    expect(second).not.toContain("zqxbody");
    expect(JSON.parse(second).wakes).toBeUndefined();
  });
});
