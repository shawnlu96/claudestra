/**
 * lib/workflow-archive.ts + lib/archive-copy.ts：会话归档补上 workflow 的运行 JSON / 脚本 / journal 与子 agent 对话。
 * jsonl 更大才覆盖；其余内容变了就镜像、坏 JSON 不替换好副本；临时文件 + rename，失败报出来而不是当「没变化」。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyIfChanged } from "../src/lib/archive-copy.js";
import { archiveWorkflowDirs, findWorkflowSessions } from "../src/lib/workflow-archive.js";

const root = mkdtempSync(join(tmpdir(), "wf-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const projects = join(root, "projects");
const src = join(projects, "slug", "sid-1");
const dest = join(root, "archive", "agent-x", "sid-1");
const put = (rel: string, body: string, base = src) => {
  const p = join(base, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};
const rel = (xs: string[]) => xs.map((f) => f.slice(dest.length + 1)).sort();

describe("archiveWorkflowDirs", () => {
  test("两处目录原样落进归档；再跑一次没有新东西；顶层 subagents 不归这里管", async () => {
    put("workflows/wf_a.json", '{"status":"running","agents":3}');
    put("workflows/scripts/review-wf_a.js", "export const meta = {}");
    put("subagents/workflows/wf_a/journal.jsonl", '{"n":1}\n');
    put("subagents/workflows/wf_a/agent-1.jsonl", '{"m":1}\n');
    put("subagents/agent-top.jsonl", "由 session-archive 自己拷");
    const first = await archiveWorkflowDirs(src, dest);
    expect(rel(first.copied)).toEqual([
      "subagents/workflows/wf_a/agent-1.jsonl",
      "subagents/workflows/wf_a/journal.jsonl",
      "workflows/scripts/review-wf_a.js",
      "workflows/wf_a.json",
    ]);
    expect(first.failed).toEqual([]);
    expect(existsSync(join(dest, "subagents", "agent-top.jsonl"))).toBe(false);
    expect(await archiveWorkflowDirs(src, dest)).toEqual({ copied: [], failed: [] });
  });

  test("运行 JSON 被重写得更小、或同样大小改了内容 → 镜像；jsonl 缩水 → 不回写", async () => {
    put("workflows/wf_a.json", '{"status":"done"}');
    put("subagents/workflows/wf_a/journal.jsonl", "");
    expect(rel((await archiveWorkflowDirs(src, dest)).copied)).toEqual(["workflows/wf_a.json"]);
    put("workflows/wf_a.json", '{"status":"fail"}'); // 同样长度
    expect(rel((await archiveWorkflowDirs(src, dest)).copied)).toEqual(["workflows/wf_a.json"]);
    expect(readFileSync(join(dest, "workflows", "wf_a.json"), "utf8")).toBe('{"status":"fail"}');
    expect(readFileSync(join(dest, "subagents", "workflows", "wf_a", "journal.jsonl"), "utf8")).toBe('{"n":1}\n');
  });

  test("写了一半的坏 JSON 不替换上一份好归档，记为失败；读不了的源也记失败、原归档不动", async () => {
    put("workflows/wf_a.json", '{"status":"do');
    const r = await archiveWorkflowDirs(src, dest);
    expect(r.copied).toEqual([]);
    expect(r.failed.some((f) => f.endsWith("wf_a.json"))).toBe(true);
    expect(readFileSync(join(dest, "workflows", "wf_a.json"), "utf8")).toBe('{"status":"fail"}');
    const locked = put("workflows/scripts/review-wf_a.js", "changed");
    chmodSync(locked, 0o000);
    try {
      expect(await copyIfChanged(locked, join(dest, "workflows", "scripts", "review-wf_a.js"))).toBe("failed");
      expect(readFileSync(join(dest, "workflows", "scripts", "review-wf_a.js"), "utf8")).toBe("export const meta = {}");
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("没有 workflow 目录的会话 → 什么都不做", async () => {
    expect(await archiveWorkflowDirs(join(root, "nope"), join(root, "archive", "agent-x", "nope"))).toEqual({ copied: [], failed: [] });
    expect(existsSync(join(root, "archive", "agent-x", "nope"))).toBe(false);
  });
});

describe("findWorkflowSessions", () => {
  test("扫出所有带 workflow 目录的会话，主 jsonl 不在也算（被 CC 清了的也要抢救）", () => {
    put("subagents/workflows/wf_b/journal.jsonl", "{}\n", join(projects, "other", "sid-2"));
    put("sid-3.jsonl", "{}\n", join(projects, "other")); // 没有 workflow 的会话
    const found = findWorkflowSessions(projects).map((x) => `${x.slug}/${x.sid}`).sort();
    expect(found).toEqual(["other/sid-2", "slug/sid-1"]);
    expect(findWorkflowSessions(join(root, "missing"))).toEqual([]);
  });
});
