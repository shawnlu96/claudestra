/**
 * 入站正文规整（src/lib/inbound-body.ts）：纯附件消息不再把 bridge 注入头当正文显示（T23）。
 * 覆盖 CC 历史解包、Pi 裸记录、API 入口正文、web 历史还原附件四段。
 */

import { describe, expect, test } from "bun:test";
import {
  channelAttachmentPaths,
  channelBodyText,
  hasInboundHeader,
  stripChannelHeader,
  withAttachmentLines,
} from "../src/lib/inbound-body.js";
import { unwrapChannelMessage } from "../src/lib/session-history.js";
import { wrapPiInboundAsChannel } from "../src/lib/pi-session.js";
import { extractAttachments } from "@/lib/chat/attachments";

// renderContentForLocal 对 API 用户拼出的形状：两行头 + 空行 + 正文
const WEB_HEAD =
  "[🌐 来自 Web 端用户「owner」（HTTP API 接入，非 Discord）。\n" +
  "用 reply() 回答到本 chat_id。对方界面完整渲染 Markdown（表格可用），且能看到本频道完整聊天记录——不要复述上下文；也不要引用与本请求无关的内容。]";
const webBody = (content: string) => [WEB_HEAD, "", content].join("\n");
const IMG = "/Users/x/.claude-orchestrator/inbox/api_1790601404127_image.png";
const PDF = "/Users/x/.claude-orchestrator/inbox/api_1790601404200_report.pdf";
const ATTRS = (paths: string[]) =>
  `source="claudestra" chat_id="api:owner:self" user="owner" user_id="api:owner:self" api="true" attachment_count="${paths.length}" attachments="${paths.join(";")}"`;
const wrap = (attrs: string, body: string) => `<channel ${attrs}>\n${body}\n</channel>`;

describe("stripChannelHeader", () => {
  test("正文为空（纯附件）：trim 之后没有空行边界，也要整段剥掉", () => {
    expect(stripChannelHeader(webBody(""))).toBe("");
    expect(stripChannelHeader(webBody("").trim())).toBe("");
  });

  test("有正文：只剥头；头里的 ] 不截断", () => {
    expect(stripChannelHeader(webBody("看下这张图"))).toBe("看下这张图");
    expect(stripChannelHeader("[🤖 来自 a 的 inbound 消息。\n[DIRECT] 标记。]\n\n请检查 [这个] 模块")).toBe("请检查 [这个] 模块");
  });

  test("其它来源的头（🤖 / 🤝）正文为空时也剥干净", () => {
    expect(stripChannelHeader("[🤖 来自 agent-a 的 inbound 消息（非 FYI）。\n规则：有干货才说话。]\n\n")).toBe("");
    expect(stripChannelHeader("[🤝 来自 peer 实例「he」的跨机请求。\n用 reply() 回答。]")).toBe("");
  });

  test("不是注入头的 [ 开头文本原样保留", () => {
    expect(stripChannelHeader("[临时] 看下这个报错")).toBe("[临时] 看下这个报错");
    expect(stripChannelHeader("[🌐 其实只是一句] 普通话")).toBe("[🌐 其实只是一句] 普通话");
  });
});

describe("withAttachmentLines / channelAttachmentPaths", () => {
  test("空正文只剩附件行；有正文则空一行接在后面", () => {
    expect(withAttachmentLines("", [IMG])).toBe(`[attachment: ${IMG}]`);
    expect(withAttachmentLines("看图", [IMG, PDF])).toBe(`看图\n\n[attachment: ${IMG}]\n[attachment: ${PDF}]`);
  });

  test("正文里已有的路径不重复（Discord 入口正文与属性各一份）", () => {
    const discord = `看图\n\n[attachment: ${IMG}]`;
    expect(withAttachmentLines(discord, [IMG])).toBe(discord);
    expect(withAttachmentLines("hi", undefined)).toBe("hi");
  });

  test("属性值按 ; 拆开、解 XML 实体；没有属性给空数组", () => {
    expect(channelAttachmentPaths(ATTRS([IMG, PDF]))).toEqual([IMG, PDF]);
    expect(channelAttachmentPaths('attachments="/a/b&amp;c.png"')).toEqual(["/a/b&c.png"]);
    expect(channelAttachmentPaths('source="claudestra" user="x"')).toEqual([]);
  });

  test("channelBodyText：剥头 + 补附件行", () => {
    expect(channelBodyText(ATTRS([IMG]), webBody(""))).toBe(`[attachment: ${IMG}]`);
    expect(channelBodyText('user="x"', webBody(""))).toBe("");
  });
});

describe("CC 历史解包（unwrapChannelMessage）", () => {
  test("线上旧记录：纯图片、正文为空、附件只在属性里 → 只剩附件行，不再是抬头", () => {
    const raw = wrap(ATTRS([IMG]), webBody(""));
    expect(unwrapChannelMessage(raw)).toEqual({ text: `[attachment: ${IMG}]`, from: "owner", fromId: "api:owner:self" });
  });

  test("新记录：API 入口已把附件写进正文 → 不重复", () => {
    const raw = wrap(ATTRS([IMG, PDF]), webBody(withAttachmentLines("", [IMG, PDF])));
    expect(unwrapChannelMessage(raw)?.text).toBe(`[attachment: ${IMG}]\n[attachment: ${PDF}]`);
  });

  test("附件 + 文字", () => {
    const raw = wrap(ATTRS([IMG]), webBody("这里为什么是红的"));
    expect(unwrapChannelMessage(raw)?.text).toBe(`这里为什么是红的\n\n[attachment: ${IMG}]`);
  });

  test("只有头、没有附件也没有正文 → 不进历史（null），而不是显示抬头", () => {
    expect(unwrapChannelMessage(wrap('user="owner"', webBody("")))).toBeNull();
  });
});

describe("Pi 裸记录（wrapPiInboundAsChannel → unwrap）", () => {
  test("Pi 会话里带裸抬头 + 附件行 → 解出附件行", () => {
    const text = webBody(withAttachmentLines("", [IMG]));
    expect(hasInboundHeader(text)).toBe(true);
    expect(unwrapChannelMessage(wrapPiInboundAsChannel(text))).toEqual({ text: `[attachment: ${IMG}]`, from: "owner" });
  });

  test("Pi 旧记录只有抬头（当时扩展没收到附件）→ 丢掉，不显示抬头", () => {
    expect(unwrapChannelMessage(wrapPiInboundAsChannel(webBody("")))).toBeNull();
    expect(unwrapChannelMessage(wrapPiInboundAsChannel(webBody("").trim()))).toBeNull();
  });

  test("Pi 普通文字消息不动", () => {
    expect(wrapPiInboundAsChannel("hi")).toBe("hi");
    expect(unwrapChannelMessage(wrapPiInboundAsChannel(webBody("你好")))?.text).toBe("你好");
  });
});

describe("web 还原（extractAttachments）", () => {
  test("历史正文 → 空文字 + 缩略图；展示名去掉 api_时间戳 前缀", () => {
    const text = unwrapChannelMessage(wrap(ATTRS([IMG, PDF]), webBody("")))!.text;
    expect(extractAttachments(text)).toEqual({
      content: "",
      attachments: [
        { name: "image.png", kind: "image", url: "/api/v1/attachments/api_1790601404127_image.png" },
        { name: "report.pdf", kind: "file", url: "/api/v1/attachments/api_1790601404200_report.pdf" },
      ],
    });
  });
});
