/**
 * 本机 agent 之间的答复带附件（bridge.ts 的 reply 推回 caller、reply 到别的 agent 频道的转发都经 bridge/local-reply-files.ts）。
 * 旧代码两处都只传文字：pushBackToCaller 没有附件参数，forwardReplyToAgentClaude 只拿 env.content。
 * inbox、媒体索引全在临时目录；信封是直接构造的，不连 bridge、不发任何消息。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setAttachmentDirsForTest } from "../src/bridge/local-api/attachments";
import { setMediaForTest } from "../src/bridge/local-api/media-refresh";
import { stageLocalReplyFiles, withLocalAttachments } from "../src/bridge/local-reply-files";
import type { Envelope } from "../src/bridge/router";
import { withExpecting } from "../src/bridge/agent-calls";
import { closeMediaIndex } from "../src/lib/media-index";
import { replyResultText } from "../src/lib/reply-ask-schema";

const sha256 = (b: ArrayBuffer | Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

let root: string;
let inbox: string;
const src = (n: string) => join(root, "src", n);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "local-reply-files-"));
  inbox = join(root, "inbox");
  mkdirSync(inbox);
  mkdirSync(join(root, "src"));
  setAttachmentDirsForTest({ uploadDir: join(root, "uploads"), inboxDirs: [inbox] });
  setMediaForTest({ db: join(root, "media.sqlite"), thumbs: join(root, "thumbs"), agents: async () => [], sources: async () => [] });
});
afterAll(() => {
  setMediaForTest(undefined);
  setAttachmentDirsForTest(undefined);
  closeMediaIndex(join(root, "media.sqlite"));
  rmSync(root, { recursive: true, force: true });
});

/** pushBackToCaller 建的那种信封：target(B) → caller(A)，正文已经过 withExpecting */
function pushback(content: string): Envelope {
  return {
    from: { kind: "local", agentName: "agent-b", channelId: "chan-a-origin", ws: undefined as never },
    to: { kind: "local", agentName: "agent-a", channelId: "chan-a", ws: undefined as never },
    intent: "response",
    content,
    meta: { messageId: "agent_reply_1", triggerKind: "agent_tool", ts: "2026-10-04T00:00:00.000Z", threadId: "th_1" },
  };
}

describe("B 带附件答复 A：A 收到的信封带本机可读的 inbox 副本", () => {
  test("meta.attachments + 正文 [attachment: …] 行，路径在 inbox 里、内容一致；原文件删了副本照样能读", async () => {
    const p = src("report.txt");
    writeFileSync(p, "季度报告 v3");
    const staged = await stageLocalReplyFiles([p], "agent-b");
    expect(staged.warning).toBeUndefined();
    expect(staged.attachments).toHaveLength(1);
    const copy = staged.attachments[0]!;
    expect(dirname(copy)).toBe(inbox);
    expect(copy).toEndWith("_report.txt");

    const pac = { targetName: "agent-b", expecting: "拿到报告后汇总" } as Parameters<typeof withExpecting>[0];
    const env = withLocalAttachments(pushback(withExpecting(pac, "报告在附件里")), staged.attachments);
    expect(env.meta.attachments).toEqual([copy]);
    expect(env.content).toStartWith("[💡 你之前 send_to_agent 给 agent-b 时填的期望：拿到报告后汇总");
    expect(env.content).toEndWith(`报告在附件里\n\n[attachment: ${copy}]`);
    expect(env.meta.messageId).toBe("agent_reply_1"); // 其余字段原样

    unlinkSync(p); // agent 常把要发的东西放临时目录，回复完就删
    expect(existsSync(copy)).toBe(true);
    expect(sha256(await Bun.file(copy).arrayBuffer())).toBe(sha256("季度报告 v3"));
  });

  test("多个附件、同名文件：各拷一份不互相覆盖，顺序照 files", async () => {
    const a = src("a.png");
    const b = join(root, "src", "sub", "a.png");
    mkdirSync(dirname(b), { recursive: true });
    writeFileSync(a, "AAA");
    writeFileSync(b, "BBB");
    const staged = await stageLocalReplyFiles([a, b], "agent-b");
    expect(staged.attachments).toHaveLength(2);
    expect(new Set(staged.attachments).size).toBe(2);
    expect(await Bun.file(staged.attachments[0]!).text()).toBe("AAA");
    expect(await Bun.file(staged.attachments[1]!).text()).toBe("BBB");
  });
});

describe("拷不过去：reply 结果给警告，不报成功", () => {
  test("不存在 / 是目录：点名写进 warning，能拷的照样带上", async () => {
    const ok = src("ok.txt");
    writeFileSync(ok, "ok");
    const gone = src("gone.zip");
    const dir = join(root, "src");
    const staged = await stageLocalReplyFiles([ok, gone, dir], "agent-b");
    expect(staged.attachments).toHaveLength(1);
    expect(await Bun.file(staged.attachments[0]!).text()).toBe("ok");
    expect(staged.warning).toContain(gone);
    expect(staged.warning).toContain(dir);
    expect(staged.warning).not.toContain(ok);
    expect(replyResultText({ messageIds: ["1"], warning: staged.warning })).toBe(`Sent message(s): ["1"] · ⚠️ ${staged.warning}`);
  });

  test("读不了（拷贝失败）：同样写进 warning、不给路径", async () => {
    const p = src("locked.bin");
    writeFileSync(p, "secret");
    chmodSync(p, 0o000);
    try {
      const staged = await stageLocalReplyFiles([p], "agent-b");
      expect(staged.attachments).toEqual([]);
      expect(staged.warning).toContain("locked.bin");
      expect(withLocalAttachments(pushback("x"), staged.attachments).meta.attachments).toBeUndefined();
    } finally {
      chmodSync(p, 0o600);
    }
  });
});

describe("不带附件：推回逐字照旧", () => {
  test("不拷、不警告；信封原样返回", async () => {
    const calls: string[][] = [];
    const spy = async (paths: string[]) => (calls.push(paths), []);
    expect(await stageLocalReplyFiles(undefined, "agent-b", spy)).toEqual({ attachments: [] });
    expect(await stageLocalReplyFiles([], "agent-b", spy)).toEqual({ attachments: [] });
    expect(calls).toEqual([]);
    const env = pushback("答案");
    expect(withLocalAttachments(env, [])).toBe(env);
  });
});
