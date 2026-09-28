/** 入站消息头属性里的附件（<channel attachments="a;b">，网页上传只写在这里）：历史解包带出、只带附件的消息不丢 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionHistory, unwrapChannelMessage } from "../src/lib/session-history.js";

describe("unwrapChannelMessage · 头属性附件", () => {
  const wrap = (attrs: string, body: string) => `<channel ${attrs}>\n${body}\n</channel>`;
  test("头属性 attachments=\"a;b\" → attachments；只有附件没有正文的消息不再被丢", () => {
    const attrs = 'source="claudestra" user="dev" user_id="api:tok_x" attachment_count="2" attachments="/s/inbox/api_1_a.png;/s/inbox/api_2_b.pdf"';
    expect(unwrapChannelMessage(wrap(attrs, "[🌐 来自 Web 端用户「dev」。]\n\n看图"))).toEqual({
      text: "看图", from: "dev", fromId: "api:tok_x", attachments: ["/s/inbox/api_1_a.png", "/s/inbox/api_2_b.pdf"],
    });
    // 真实形态：头 + 空行 + 空正文（bridge 照常拼了空行）→ 正文为空、附件保留
    expect(unwrapChannelMessage(wrap(attrs, "[🌐 来自 Web 端用户「dev」。]\n\n\n"))).toMatchObject({ text: "", attachments: ["/s/inbox/api_1_a.png", "/s/inbox/api_2_b.pdf"] });
    expect(unwrapChannelMessage(wrap('source="claudestra" user="dev"', "[🌐 头]\n\n"))).toBeNull(); // 没正文也没附件：照旧丢
  });
});

test("readSessionHistory：user 记录与 queued 记录都带出 attachments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chan-att-"));
  try {
    const head = (mid: string, a: string) => `<channel source="claudestra" message_id="${mid}" user="dev" attachments="${a}">\n[🌐 来自 Web 端用户「dev」。]\n\n\n</channel>`;
    const lines = [
      { type: "user", isMeta: true, timestamp: "2026-09-28T10:00:00Z", message: { content: head("m1", "/s/inbox/api_1_a.png") } },
      { type: "attachment", timestamp: "2026-09-28T10:00:05Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: head("m2", "/s/inbox/api_2_b.jpg;/s/inbox/api_3_c.pdf") } },
    ];
    const f = join(dir, "s.jsonl");
    writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const page = await readSessionHistory(f);
    expect(page.messages.map((m) => [m.role, m.text, m.attachments])).toEqual([
      ["user", "", ["/s/inbox/api_1_a.png"]],
      ["user", "", ["/s/inbox/api_2_b.jpg", "/s/inbox/api_3_c.pdf"]],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
