/** lib/workflow-archive.ts：会话归档补上 workflow 的运行 JSON / 脚本 / journal 与子 agent 对话；jsonl 更大才覆盖、其余源更新就覆盖 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveWorkflowDirs } from "../src/lib/workflow-archive.js";

const root = mkdtempSync(join(tmpdir(), "wf-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const src = join(root, "projects", "slug", "sid-1");
const dest = join(root, "archive", "agent-x", "sid-1");
const put = (rel: string, body: string) => {
  const p = join(src, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};

describe("archiveWorkflowDirs", () => {
  test("两处目录原样落进归档；再跑一次没有新东西", async () => {
    put("workflows/wf_a.json", '{"status":"running","agents":3}');
    put("workflows/scripts/review-wf_a.js", "export const meta = {}");
    put("subagents/workflows/wf_a/journal.jsonl", '{"n":1}\n');
    put("subagents/workflows/wf_a/agent-1.jsonl", '{"m":1}\n');
    put("subagents/agent-top.jsonl", "不归这里管"); // 顶层 subagents 由 session-archive 自己拷
    const first = await archiveWorkflowDirs(src, dest);
    expect(first.map((f) => f.slice(dest.length + 1)).sort()).toEqual([
      "subagents/workflows/wf_a/agent-1.jsonl",
      "subagents/workflows/wf_a/journal.jsonl",
      "workflows/scripts/review-wf_a.js",
      "workflows/wf_a.json",
    ]);
    expect(existsSync(join(dest, "subagents", "agent-top.jsonl"))).toBe(false);
    expect(await archiveWorkflowDirs(src, dest)).toEqual([]);
  });

  test("运行 JSON 被重写得更小但更新 → 覆盖；jsonl 缩水 → 不回写", async () => {
    const json = put("workflows/wf_a.json", '{"status":"done"}');
    const later = new Date(Date.now() + 60_000);
    utimesSync(json, later, later);
    const jl = put("subagents/workflows/wf_a/journal.jsonl", "");
    utimesSync(jl, later, later);
    const copied = await archiveWorkflowDirs(src, dest);
    expect(copied.map((f) => f.slice(dest.length + 1))).toEqual(["workflows/wf_a.json"]);
    expect(readFileSync(join(dest, "workflows", "wf_a.json"), "utf8")).toBe('{"status":"done"}');
    expect(readFileSync(join(dest, "subagents", "workflows", "wf_a", "journal.jsonl"), "utf8")).toBe('{"n":1}\n');
  });

  test("没有 workflow 目录的会话 → 什么都不做", async () => {
    expect(await archiveWorkflowDirs(join(root, "nope"), join(root, "archive", "agent-x", "nope"))).toEqual([]);
    expect(existsSync(join(root, "archive", "agent-x", "nope"))).toBe(false);
  });
});
