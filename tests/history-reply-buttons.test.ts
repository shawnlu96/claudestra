/**
 * 网页历史不渲染没发出去的按钮（adv1 P2-1，src/lib/history-components.ts）：reply 的 tool_result 是 is_error（bridge 拒发）
 * 时去掉那次调用带的按钮 / 选单；bridge 的保留 id（lib/reserved-buttons.ts）无论如何都不渲染。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionHistory } from "../src/lib/session-history.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const row = (...ids: string[]) => [{ type: "buttons", buttons: ids.map((id) => ({ id, label: "继续" })) }];
const reply = (id: string, text: string, components: unknown) => ({ type: "tool_use", id, name: "mcp__claudestra__reply", input: { text, components } });
const result = (id: string, isError: boolean) => ({ type: "tool_result", tool_use_id: id, is_error: isError, content: isError ? "reply dropped: …" : "{}" });

async function history(records: unknown[]) {
  const p = join(mkdtempSync(join(tmpdir(), "hist-btn-")), `${SID}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return (await readSessionHistory(p)).messages.find((m) => m.role === "assistant")!;
}

describe("网页历史里的 reply 按钮", () => {
  test("被 bridge 拒掉的 reply（is_error）：按钮不渲染；同一条里发成功的那次照常", async () => {
    const asst = await history([
      { type: "assistant", timestamp: "2026-09-29T00:00:00Z", message: { content: [reply("tu1", "点继续", row("go_on")), reply("tu2", "要发布吗", row("release_go"))] } },
      { type: "user", timestamp: "2026-09-29T00:00:01Z", message: { content: [result("tu1", true), result("tu2", false)] } },
    ]);
    expect(asst.replyComponents).toEqual([{ type: "buttons", buttons: [{ id: "release_go", label: "继续" }] }]);
  });

  test("只有一次失败的 reply：replyComponents 整个不出现", async () => {
    const asst = await history([
      { type: "assistant", timestamp: "2026-09-29T00:00:00Z", message: { content: [reply("tu1", "点继续", row("go_on"))] } },
      { type: "user", timestamp: "2026-09-29T00:00:01Z", message: { content: [result("tu1", true)] } },
    ]);
    expect(asst.replyComponents).toBeUndefined();
  });

  test("保留 id 的按钮 / 选单一律不渲染（即使没有 tool_result，比如尾读窗口外）", async () => {
    const select = { type: "select", id: "kill_agent", options: [{ label: "x", value: "x" }] };
    const asst = await history([
      { type: "assistant", timestamp: "2026-09-29T00:00:00Z", message: { content: [reply("tu1", "点继续", [...row("ok", "team_ok:0a1b2c3d:0123456789abcdef", "auto_allow:1"), select])] } },
    ]);
    expect(asst.replyComponents).toEqual([{ type: "buttons", buttons: [{ id: "ok", label: "继续" }] }]);
  });
});
