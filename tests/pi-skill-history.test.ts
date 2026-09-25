import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readSessionHistory, searchSessionHistory } from "../src/lib/session-history.js";

// Pi 调技能时把整份 SKILL.md 包成 <skill …>…</skill> 记成 user 消息——历史里要折成「/名字 参数」细条，不是用户气泡
const skillText = (name: string, args = "") => {
  const dir = `/Users/x/.pi/agent/skills/${name}`;
  const body = `<skill name="${name}" location="${dir}/SKILL.md">\nReferences are relative to ${dir}.\n\n# 保存记忆\n整段技能说明……\n</skill>`;
  return args ? `${body}\n\n${args}` : body;
};

const root = mkdtempSync(join(tmpdir(), "pi-skill-"));
const prevDir = process.env.PI_CODING_AGENT_DIR;
beforeAll(() => { process.env.PI_CODING_AGENT_DIR = root; }); // 认 Pi 会话靠路径落在 piAgentDir()/sessions 下
afterAll(() => {
  if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevDir;
});

let n = 0;
function piSession(texts: string[]): string {
  const dir = join(root, "sessions", `--proj-${++n}--`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "2026-09-25T16-07-16-378Z_01a093e3-e914-71c8-90f7-b97891100e20.jsonl");
  const recs = texts.map((text, i) => ({
    type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: `2026-09-25T16:07:1${i}.000Z`,
    message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  }));
  writeFileSync(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

describe("Pi 技能调用记录", () => {
  test("折成 system 细条，带参数的保留参数", async () => {
    const p = piSession([skillText("save-compact"), skillText("code-review", "PR 12"), "正常消息"]);
    const page = await readSessionHistory(p);
    expect(page.messages.map((m) => [m.role, m.text])).toEqual([
      ["system", "/save-compact"],
      ["system", "/code-review PR 12"],
      ["user", "正常消息"],
    ]);
  });

  test("历史搜索不命中技能正文", async () => {
    const p = piSession([skillText("save-compact"), "保存记忆的事"]);
    const hits = await searchSessionHistory(p, "保存记忆");
    expect(hits.map((h) => h.snippet.includes("保存记忆的事"))).toEqual([true]);
  });
});
