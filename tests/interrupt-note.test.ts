/**
 * i28-INT1：打断抬头在会话历史里剥掉（src/lib/interrupt-note.ts 共用开头措辞）。
 * 夹具一律调 turn-cuts 的真函数生成，不手抄措辞：改了抬头措辞而剥离没跟上，这里会红。
 */
import { describe, expect, test } from "bun:test";
import { unwrapChannelMessage } from "../src/lib/session-history.js";
import {
  heldAcrossStopNote, inflightFrom, makeCut, preemptHeadline, stopHeadline, withInterruptNote,
  type CutEvent, type NewCutInput, type StopOutcome,
} from "../src/lib/turn-cuts.js";

const T0 = Date.parse("2026-10-03T01:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const start = (id: string, cmd: string): CutEvent => ({
  type: "tool_start", ts: iso(T0), data: { toolId: id, name: "Bash", summary: cmd, detail: `描述\n───\n${cmd}` },
});
const cut = (runtime?: string) =>
  makeCut({ id: "cut_1", agent: "a", channelId: "ch", at: T0 + 1000, cause: "preempt", tools: inflightFrom([start("t1", "sleep 30")]), ...(runtime ? { runtime } : {}) } satisfies NewCutInput);

const WEB_HEAD = "[🌐 来自 Web 端用户「owner」（HTTP API 接入，非 Discord）。\n用 reply() 回答到本 chat_id。]\n\n";
const IMG = "/Users/x/.claude-orchestrator/inbox/api_1790957171228_image.png";
/** Claude Code 会话记录里 bridge 入站的形状（renderContentForLocal 渲染 → withInterruptNote → <channel> 包装） */
const apiRec = (body: string, note = true, extra = "") =>
  `<channel source="claudestra" chat_id="api:owner:self" message_id="m1" user="owner" user_id="api:owner:self" api="true"${note ? ' interrupt_note="true"' : ""}${extra}>\n${body}\n</channel>`;
const discordRec = (body: string, note = true) =>
  `<channel source="claudestra" chat_id="123" message_id="m2" user="owner" user_id="u1"${note ? ' interrupt_note="true"' : ""}>\n${body}\n</channel>`;

const ORIGINAL = "这个bug也很久了";

describe("自动抢占的抬头（owner 10-03 截图复现）", () => {
  test("preemptHeadline 实际生成的抬头 + withInterruptNote：历史正文 = 原文，不含 ⚡ 抬头", () => {
    for (const rt of [undefined, "codex", "pi"]) {
      const body = withInterruptNote(`${WEB_HEAD}${ORIGINAL}`, preemptHeadline(cut(rt)));
      expect(body).toContain("系统自动中断了上一回合"); // 确实是新措辞的抬头
      const text = unwrapChannelMessage(apiRec(body))?.text;
      expect(text).toBe(ORIGINAL);
      expect(text).not.toContain("⚡");
    }
  });

  test("Discord 入站（没有来源头）同样剥掉", () => {
    expect(unwrapChannelMessage(discordRec(withInterruptNote(ORIGINAL, preemptHeadline(cut()))))?.text).toBe(ORIGINAL);
  });
});

describe("叫停 / 叫停前押后的抬头", () => {
  const outcomes: StopOutcome[] = ["fired", "requested", "not_busy", "failed", "wall_wait"];
  for (const o of outcomes) {
    test(`stopHeadline(${o}) 剥掉`, () => {
      const note = stopHeadline(cut(), o, ["部署一下"], 1);
      expect(unwrapChannelMessage(apiRec(withInterruptNote(`${WEB_HEAD}停`, note)))?.text).toBe("停");
      expect(unwrapChannelMessage(discordRec(withInterruptNote("停", note)))?.text).toBe("停");
    });
  }

  test("heldAcrossStopNote 剥掉", () => {
    const note = heldAcrossStopNote(T0, T0 + 60_000);
    expect(unwrapChannelMessage(apiRec(withInterruptNote(`${WEB_HEAD}${ORIGINAL}`, note)))?.text).toBe(ORIGINAL);
  });
});

describe("只剥 bridge 真加的抬头", () => {
  test("没有 interrupt_note 属性：用户手写的同样开头不剥，原样显示", () => {
    const spoof = `${preemptHeadline(cut())}\n\n真正要说的`;
    expect(unwrapChannelMessage(apiRec(`${WEB_HEAD}${spoof}`, false))?.text).toBe(spoof);
    expect(unwrapChannelMessage(discordRec(spoof, false))?.text).toBe(spoof);
    const stopSpoof = `${stopHeadline(cut(), "fired")}\n\n真正要说的`;
    expect(unwrapChannelMessage(discordRec(stopSpoof, false))?.text).toBe(stopSpoof);
  });
});

describe("带附件的打断消息", () => {
  test("剥完抬头后 [attachment: …] 行还在", () => {
    const body = withInterruptNote(`${WEB_HEAD}看这张图\n\n[attachment: ${IMG}]`, preemptHeadline(cut()));
    const un = unwrapChannelMessage(apiRec(body, true, ` attachment_count="1" attachments="${IMG}"`));
    expect(un?.text).toBe(`看这张图\n\n[attachment: ${IMG}]`);
    expect(un?.attachments).toEqual([IMG]);
  });

  test("纯附件（正文只有附件行，旧记录附件只在属性里）", () => {
    const body = withInterruptNote(`${WEB_HEAD}`, preemptHeadline(cut()));
    expect(unwrapChannelMessage(apiRec(body, true, ` attachment_count="1" attachments="${IMG}"`))?.text).toBe(`[attachment: ${IMG}]`);
  });
});
