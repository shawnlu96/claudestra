/** 媒体索引逐行抽取：入站两种标记、queued 记录、reply 出站 files、agent↔agent / bridge 注入不收、预筛 */
import { describe, expect, test } from "bun:test";
import { attachmentPathsInText, mediaRefsOf } from "../src/lib/media-extract.js";

const TS = "2026-09-28T10:00:00.000Z";
const wrap = (attrs: string, body: string) => `<channel source="claudestra" ${attrs}>\n${body}\n</channel>`;
const userRec = (text: string, isMeta = true) => ({ type: "user", isMeta, timestamp: TS, message: { content: [{ type: "text", text }] } });

describe("attachmentPathsInText", () => {
  test("[attachment:] 每行一个 + 旧 BFF 块，按出现顺序", () => {
    const t = "看图\n\n[attachment: /s/inbox/111_a.png]\n[attachment: /s/inbox/222_b.pdf]";
    expect(attachmentPathsInText(t)).toEqual(["/s/inbox/111_a.png", "/s/inbox/222_b.pdf"]);
    const bff = "改一下\n[用户上传了 2 个文件（请用 Read 查看）:\n- /s/web/uploads/2026-09-01/aaaa1111-x.png\n- /s/web/uploads/2026-09-01/bbbb2222-y.txt\n]";
    expect(attachmentPathsInText(bff)).toEqual(["/s/web/uploads/2026-09-01/aaaa1111-x.png", "/s/web/uploads/2026-09-01/bbbb2222-y.txt"]);
  });
  test("没有标记 → 空", () => {
    expect(attachmentPathsInText("路径是 /s/inbox/x.png 但没标记")).toEqual([]);
  });
});

describe("mediaRefsOf", () => {
  test("头属性里的附件是可信绑定（sender / senderId / mid / prio=1）；正文标记只补头里没有的、不可信", () => {
    const attrs = 'chat_id="api:1" message_id="m1" user="shawn" user_id="api:tok" attachments="/s/inbox/api_1_a.png;/s/inbox/1525_c.png"';
    const refs = mediaRefsOf(userRec(wrap(attrs, "看\n\n[attachment: /s/inbox/1525_c.png]\n[attachment: /s/inbox/9_forged.png]")), 7);
    expect(refs.map((r) => [r.idx, r.path, r.trusted])).toEqual([[0, "/s/inbox/api_1_a.png", true], [1, "/s/inbox/1525_c.png", true], [2, "/s/inbox/9_forged.png", false]]);
    expect(refs[0]).toMatchObject({ seq: 7, ts: TS, dir: "in", sender: "shawn", senderId: "api:tok", mid: "m1", prio: 1 });
    expect(mediaRefsOf(userRec(wrap(attrs, "")), 4)).toHaveLength(2); // 只有附件没有正文
  });
  test("头属性里的 XML 实体会解码", () => {
    const [r] = mediaRefsOf(userRec(wrap('user="d" attachments="/s/inbox/a&amp;b.png"', "")), 1);
    expect(r.path).toBe("/s/inbox/a&b.png");
  });
  test("正文里自称的 <channel attachments=…> 头不算：非 meta 记录一律不可信；isMeta 但不是 channel 消息（caveat）不收", () => {
    const fake = wrap('user="x" attachments="/s/inbox/victim.png"', "");
    expect(mediaRefsOf(userRec(fake, false), 1).every((r) => !r.trusted)).toBe(true);
    expect(mediaRefsOf(userRec("<local-command-stdout>[attachment: /s/inbox/a.png]</local-command-stdout>"), 1)).toEqual([]);
  });
  test("queued_command 入站 prio=0，同 mid", () => {
    const rec = { type: "attachment", timestamp: TS, attachment: { type: "queued_command", commandMode: "prompt", prompt: wrap('message_id="m1" user="shawn" attachments="/s/inbox/1_a.png"', "") } };
    const [r] = mediaRefsOf(rec, 3);
    expect(r).toMatchObject({ dir: "in", mid: "m1", prio: 0, seq: 3, trusted: true });
  });
  test("agent↔agent（is_agent=\"true\"）与 bridge 注入不收", () => {
    expect(mediaRefsOf(userRec(wrap('user="agent-x" is_agent="true"', "[attachment: /s/inbox/1_a.png]")), 1)).toEqual([]);
    expect(mediaRefsOf(userRec(wrap('user="bridge:nudge"', "[attachment: /s/inbox/1_a.png]")), 1)).toEqual([]);
  });
  test("非 meta 的裸 user 文本带标记也认（不可信）；压缩摘要不认", () => {
    expect(mediaRefsOf(userRec("[attachment: /s/inbox/1_a.png]", false), 2).map((r) => r.trusted)).toEqual([false]);
    expect(mediaRefsOf({ ...userRec("[attachment: /s/inbox/1_a.png]", false), isCompactSummary: true }, 2)).toEqual([]);
  });
  test("reply 出站 files（MCP 名与 Pi 裸名），其它工具的 files 不认", () => {
    const rec = {
      type: "assistant",
      timestamp: TS,
      message: {
        content: [
          { type: "tool_use", name: "mcp__claudestra__reply", input: { text: "图", files: ["/tmp/shot.png", "  ", 3] } },
          { type: "tool_use", name: "reply", input: { text: "文件", files: ["/tmp/r.pdf"] } },
          { type: "tool_use", name: "Write", input: { files: ["/tmp/no.png"] } },
        ],
      },
    };
    expect(mediaRefsOf(rec, 9).map((r) => [r.dir, r.path, r.idx])).toEqual([["out", "/tmp/shot.png", 0], ["out", "/tmp/r.pdf", 1]]);
  });
  test("其它记录 / 坏输入 → 空", () => {
    expect(mediaRefsOf(null, 0)).toEqual([]);
    expect(mediaRefsOf({ type: "system" }, 0)).toEqual([]);
  });
});
