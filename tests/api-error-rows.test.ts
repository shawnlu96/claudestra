/**
 * lib/api-error-rows.ts 与历史解析：API 错误条目画成一行系统提示，连续相同的合并成「×N」（seq 取最新），
 * 中间隔了别的消息就不并。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiErrorNotice, pushApiErrorRow } from "../src/lib/api-error-rows.js";
import { readSessionHistory } from "../src/lib/session-history.js";

const dir = mkdtempSync(join(tmpdir(), "api-error-rows-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const LIMIT = "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)";
const err = (text: string, ts: string) => ({
  type: "assistant", timestamp: ts, isApiErrorMessage: true, error: "rate_limit",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
});
const said = (text: string, ts: string) => ({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
const user = (text: string, ts: string) => ({ type: "user", timestamp: ts, message: { role: "user", content: text } });

describe("历史里的 API 错误", () => {
  test("连续三条相同的并成一条 ×3，seq 取最后一条；隔了消息的另起一条；不是 assistant 气泡", async () => {
    const p = join(dir, "s.jsonl");
    const rows = [
      said("先看下代码", "2026-09-28T13:19:00Z"),
      err(LIMIT, "2026-09-28T13:19:40Z"),
      err(LIMIT, "2026-09-28T13:19:45Z"),
      err(LIMIT, "2026-09-28T13:19:52Z"),
      user("接着做", "2026-09-28T13:20:00Z"),
      err(LIMIT, "2026-09-28T13:20:05Z"),
    ];
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { messages } = await readSessionHistory(p, {});
    const shape = messages.map((m) => [m.role, m.text]);
    expect(shape).toEqual([
      ["assistant", "先看下代码"],
      ["system", `⛔ ×3 ${LIMIT}`],
      ["user", "接着做"],
      ["system", `⛔ ${LIMIT}`],
    ]);
    expect(messages[1].seq).toBe(3);
    expect(messages[1].ts).toBe("2026-09-28T13:19:52Z");
  });

  test("不同的错误不合并；多行原文只取首行", async () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, [err("API Error: 500 upstream\nstack…", "2026-09-28T01:00:00Z"), err(LIMIT, "2026-09-28T01:00:05Z")].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { messages } = await readSessionHistory(p, {});
    expect(messages.map((m) => m.text)).toEqual(["⛔ API Error: 500 upstream", `⛔ ${LIMIT}`]);
    expect(apiErrorNotice("  x  ")).toBe("⛔ x");
  });

  test("Codex 的额度条目（lib/codex-session.ts 译过来不带 isApiErrorMessage、带 error）也是系统行，和直播一致；agent 正文不算", () => {
    const codex = "You've hit your usage limit. Upgrade to Pro or try again at 8:41 AM.";
    const rows: { seq: number; ts: string | null; role: "user" | "assistant" | "system"; text: string }[] = [];
    expect(pushApiErrorRow(rows, { error: codex, message: { content: [{ type: "text", text: codex }] } }, 1, null)).toBe(true);
    expect(rows).toEqual([{ seq: 1, ts: null, role: "system", text: `⛔ ${codex}` }]);
    expect(pushApiErrorRow(rows, { message: { content: [{ type: "text", text: codex }] } }, 2, null)).toBe(false);
  });
});
