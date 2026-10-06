// lib/bg-shell-dirs：从主会话 jsonl 里 CC 落的后台 shell 启动结果认出输出目录的会话段（会话轮转后 shell 仍写旧会话的 tasks/）
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ReportedShellDirs, reportedShells } from "../src/lib/bg-shell-dirs";

const SLUG = "-Users-he-repos-claudestra";
const out = (seg: string, id: string, slug = SLUG) => `/private/tmp/claude-501/${slug}/${seg}/tasks/${id}.output`;
const launch = (id: string, path: string, structuredId: string | null = id, lead = "Command running in background with ID: " + id) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: [{ type: "text", text: `${lead}. Output is being written to: ${path}. You will be notified.` }] }] },
    ...(structuredId === null ? {} : { toolUseResult: { stdout: "", backgroundTaskId: structuredId } }),
  }) + "\n";

describe("reportedShells", () => {
  test("CC 的两种启动结果（后台启动 / 600s 超时转后台）都认出任务 id 与输出目录的会话段", () => {
    const text = launch("b1", out("sess-A", "b1")) +
      launch("b2", out("sess-A", "b2"), "b2", "Command did not complete within its 600s timeout and was moved to the background (ID: b2)") +
      launch("b3", out("sess-C", "b3"));
    expect(reportedShells(text, SLUG)).toEqual([{ id: "b1", seg: "sess-A" }, { id: "b2", seg: "sess-A" }, { id: "b3", seg: "sess-C" }]);
  });

  test("不认：没有结构化 backgroundTaskId、路径不是该任务自己的文件、slug 对不上、会话段带路径符号、坏行", () => {
    const text = launch("q1", out("sess-Q", "q1"), null) + // 正文里引用的同款句子
      launch("q2", out("sess-Q", "other"), "q2") +
      launch("q3", out("sess-Q", "q3", "-Users-someone-else"), "q3") +
      launch("q4", `/private/tmp/claude-501/${SLUG}/../tasks/q4.output`, "q4") +
      '{"toolUseResult":{"backgroundTaskId":"q5"}, "message": {"content": "Output is being written to: ' + out("sess-Q", "q5") + "\n";
    expect(reportedShells(text, SLUG)).toEqual([]);
  });
});

const sessions = async (d: ReportedShellDirs, p: string) => (await d.scan(p, SLUG)).sessions;

describe("ReportedShellDirs", () => {
  const root = mkdtempSync(join(tmpdir(), "bg-shell-dirs-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("增量累计：半行等写完再认，已认出的保留；文件变短从尾部重来；文件不在 = 空", async () => {
    const p = join(root, "main.jsonl");
    const dirs = new ReportedShellDirs();
    expect(await sessions(dirs, p)).toEqual([]);
    const line = launch("b1", out("sess-A", "b1"));
    writeFileSync(p, line.slice(0, 40));
    expect(await sessions(dirs, p)).toEqual([]);
    appendFileSync(p, line.slice(40) + launch("b2", out("sess-B", "b2")));
    expect(await sessions(dirs, p)).toEqual(["sess-A", "sess-B"]);
    expect([...(await dirs.scan(p, SLUG)).ids]).toEqual(["b1", "b2"]);
    appendFileSync(p, '{"type":"assistant"}\n');
    expect(await sessions(dirs, p)).toEqual(["sess-A", "sess-B"]);
    writeFileSync(p, launch("c1", out("sess-C", "c1")));
    expect(await sessions(dirs, p)).toEqual(["sess-C"]);
    dirs.retain([]);
    rmSync(p);
    expect(await sessions(dirs, p)).toEqual([]);
  });
});
