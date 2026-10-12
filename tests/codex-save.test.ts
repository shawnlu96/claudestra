/**
 * Codex（ACP）/save-compact、/save-clear 编排（src/bridge/codex-save.ts + lib/codex-save.ts）：注入假的 ACP 通道，
 * 钉住顺序（落盘回合结束 → 才压缩 / 换会话 → 新会话首轮带交接）和「任何一步失败停在原地」。
 */
import { describe, expect, test } from "bun:test";
import { startCodexSave, type CodexSaveLink, type CodexSaveResult } from "../src/bridge/codex-save.js";
import { checkHandoff, codexHandoffPath, codexRestorePrompt, codexSavePrompt, handoffMarker, HANDOFF_MAX_BYTES } from "../src/lib/codex-save.js";
import type { SlotOutcome } from "../src/lib/acp/turn.js";

type Outcome = SlotOutcome | "gone" | "never";
interface FakeOpts {
  save?: Outcome;
  compact?: Outcome;
  restore?: Outcome;
  /** 落盘回合写进文件的东西：fresh = 带本轮标记的正经交接 */
  file?: "fresh" | "stale" | "none";
  clear?: { ok: boolean; uncertain?: true; error?: string };
  submitFail?: "save" | "compact";
}

const BODY = "# HANDOFF\n## 在做什么\n修 CXS-1，下一步写测试";

function fakeLink(o: FakeOpts = {}) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const prompts: string[] = [];
  const outcomes = new Map<string, Outcome>();
  const step = (opId: string) => opId.split("-")[0] as "save" | "compact" | "restore";
  const submit = (kind: "op" | "slash", text: string, opId: string) => {
    const s = step(opId);
    calls.push(`${kind}:${s}${kind === "slash" ? `:${text}` : ""}`);
    prompts.push(text);
    if (o.submitFail === s) return Promise.resolve({ ok: false, error: "ACP 宿主不在线" });
    outcomes.set(opId, (o as Record<string, Outcome | undefined>)[s] ?? "done");
    if (s === "save") {
      const path = /路径：(\S+)（/.exec(text)![1];
      if (o.file !== "none") files.set(path, `${o.file === "stale" ? handoffMarker("save-old") : handoffMarker(opId)}\n${BODY}`);
    }
    return Promise.resolve({ ok: true, slot: { state: "queued" as const, opId, gen: 1, hostId: "h1" } });
  };
  const link: CodexSaveLink = {
    opTurn: (_ch, text, opId) => submit("op", text, opId),
    slash: (_ch, text, opId) => submit("slash", text, opId),
    slotStatus: async (_ch, opId, ref) => {
      expect(ref).toEqual({ hostId: "h1", gen: 1 });
      const out = outcomes.get(opId)!;
      calls.push(`wait:${step(opId)}`);
      if (out === "never") return (await Bun.sleep(10), { ok: false, uncertain: true, error: "宿主未在期限内回应" }); // 真宿主要等满 waitMs
      if (out === "gone") return { ok: true, slot: { state: "gone" as const, opId, hostId: "h1" } };
      return { ok: true, slot: { state: "ended" as const, opId, gen: 1, outcome: out, hostId: "h1" } };
    },
    clear: async () => (calls.push("clear"), o.clear ?? { ok: true, sessionId: "new-sid" }),
  };
  return { link, calls, files, prompts };
}

let seq = 0;
async function run(kind: "save-compact" | "save-clear", o: FakeOpts = {}) {
  const f = fakeLink(o);
  const notes: string[] = [];
  const started = startCodexSave(kind, { name: `agent-codex-t${++seq}`, channelId: "ch" }, {
    link: f.link, notify: (t) => void notes.push(t), readHandoff: async (p) => f.files.get(p) ?? null, slotBudgetMs: 50, pollMs: 10,
  });
  if ("error" in started) throw new Error(started.error);
  const res: CodexSaveResult = await started.run;
  return { ...f, notes, res };
}

describe("/save-compact", () => {
  test("先落盘回合、等它结束，再发 /compact、等压缩结束", async () => {
    const { calls, res, notes } = await run("save-compact");
    expect(calls).toEqual(["op:save", "wait:save", "slash:compact:/compact", "wait:compact"]);
    expect(res).toMatchObject({ ok: true, kind: "save-compact" });
    expect(notes.at(-1)).toContain("✅");
  });

  for (const [why, o] of [
    ["落盘回合失败", { save: "failed" }], ["落盘回合被打断", { save: "cancelled" }], ["宿主不认这一轮", { save: "gone" }],
    ["一直等不到结局", { save: "never" }], ["交不给宿主", { submitFail: "save" }],
    ["回合结束了但没写文件", { file: "none" }], ["文件是上次留下的", { file: "stale" }],
  ] as [string, FakeOpts][]) {
    test(`${why}：不发 /compact，给出可见原因`, async () => {
      const { calls, res, notes } = await run("save-compact", o);
      expect(calls.some((c) => c.startsWith("slash"))).toBe(false);
      expect(res).toMatchObject({ ok: false, stage: "save" });
      expect(notes.at(-1)).toMatch(/^⚠️ \/save-compact 停在「存交接」：.*没有压缩/);
    });
  }

  test("压缩回合失败：报压缩失败，交接还在", async () => {
    const { res, notes } = await run("save-compact", { compact: "failed" });
    expect(res).toMatchObject({ ok: false, stage: "compact" });
    expect(notes.at(-1)).toContain("交接已存在");
  });
});

describe("/save-clear", () => {
  test("先落盘 → 回合结束后才 acpClear → 新会话第一轮带上交接原文", async () => {
    const { calls, res, prompts } = await run("save-clear");
    expect(calls).toEqual(["op:save", "wait:save", "clear", "op:restore", "wait:restore"]);
    expect(res).toMatchObject({ ok: true, sessionId: "new-sid" });
    expect(prompts.at(-1)).toContain(BODY);
  });

  test("落盘失败不 clear", async () => {
    for (const o of [{ save: "failed" }, { file: "stale" }] as FakeOpts[]) {
      const { calls, res } = await run("save-clear", o);
      expect(calls).not.toContain("clear");
      expect(res).toMatchObject({ ok: false, stage: "save" });
    }
  });

  test("acpClear 结果不明：504 语义报出，只清一次、不回读", async () => {
    const { calls, res, notes } = await run("save-clear", { clear: { ok: false, uncertain: true, error: "宿主未在期限内回应，结果未确认" } });
    expect(calls.filter((c) => c === "clear")).toHaveLength(1);
    expect(calls).not.toContain("op:restore");
    expect(res).toMatchObject({ ok: false, stage: "clear", status: 504, code: "clear_result_unknown" });
    expect(notes.at(-1)).toContain("没有重试");
  });

  test("acpClear 明确失败：不回读，告诉 owner 交接在哪", async () => {
    const { res, calls } = await run("save-clear", { clear: { ok: false, error: "ACP 宿主不在线" } });
    expect(res).toMatchObject({ ok: false, stage: "clear" });
    expect("status" in res).toBe(false);
    expect(calls).not.toContain("op:restore");
  });

  test("新会话回读那一轮失败：报出来（会话已换）", async () => {
    const { res, notes } = await run("save-clear", { restore: "failed" });
    expect(res).toMatchObject({ ok: false, stage: "restore" });
    expect(notes.at(-1)).toContain("已换到新会话");
  });
});

test("同一 agent 同时只跑一个；名字不能当目录时什么都不发", async () => {
  const f = fakeLink();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const link: CodexSaveLink = { ...f.link, slotStatus: async (...a) => (await gate, f.link.slotStatus(...a)) };
  const deps = { link, notify: () => {}, readHandoff: async (p: string) => f.files.get(p) ?? null, slotBudgetMs: 1_000, pollMs: 500 };
  const first = startCodexSave("save-compact", { name: "agent-busy", channelId: "ch" }, deps);
  expect(startCodexSave("save-clear", { name: "agent-busy", channelId: "ch" }, deps)).toEqual({ error: expect.stringContaining("已有一个") });
  release();
  await ("run" in first ? first.run : null);
  expect("run" in startCodexSave("save-compact", { name: "agent-busy", channelId: "ch" }, { ...deps, link: f.link })).toBe(true);
  expect(startCodexSave("save-compact", { name: "../x", channelId: "ch" }, deps)).toEqual({ error: expect.stringContaining("不能当目录") });
});

describe("lib/codex-save", () => {
  test("交接按 agent 隔离在状态目录，不进 Claude Code 的 memory", () => {
    const p = codexHandoffPath("agent-a");
    expect(p).toMatch(/[/\\]handoff[/\\]agent-a[/\\]HANDOFF\.md$/);
    expect(p).not.toContain("/.claude/projects/");
    expect(codexHandoffPath("agent-b")).not.toBe(p);
  });

  test("落盘提示词带路径和本轮标记；回读提示词带原文", () => {
    const t = codexSavePrompt("save-clear", "/s/handoff/a/HANDOFF.md", "save-op1");
    expect(t).toContain("/s/handoff/a/HANDOFF.md");
    expect(t).toContain(handoffMarker("save-op1"));
    expect(codexRestorePrompt("/p", "  正文  ")).toContain("\n正文\n");
  });

  test("checkHandoff：不在 / 旧标记 / 空 / 超限都拒", () => {
    const m = handoffMarker("op");
    expect(checkHandoff(`${m}\n${BODY}`, "op")).toEqual({ ok: true, content: BODY });
    expect(checkHandoff(`﻿${m}\r\n${BODY}`, "op").ok).toBe(true);
    expect(checkHandoff(null, "op").ok).toBe(false);
    expect(checkHandoff(`${handoffMarker("old")}\n${BODY}`, "op").ok).toBe(false);
    expect(checkHandoff(`${m}\n短`, "op").ok).toBe(false);
    expect(checkHandoff(`${m}\n${"x".repeat(HANDOFF_MAX_BYTES)}`, "op").ok).toBe(false);
  });
});
