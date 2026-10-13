/**
 * web/lib/owner-words.ts（UXTERM1 A 段）：给 owner 看的词表。阶段未知键 → 「其他」；步骤词覆盖 token 账的全部步骤键；
 * low-priority 徽章 / 批量面板 / 借出页的文案都从词表来，中英文都不含禁用词；按钮 id、lpBadgeText 返回 null 的条件不变。
 * STAGE_NAME === STAGE_WORD 属于 B 段（collab-detail-model.ts，UXTERM2），不在本文件里断言。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { STEP_LABELS, AGENT_USAGE_WORDS } from "../web/features/chat/agent-usage-i18n";
import { stageChipView } from "../web/features/chat/ledger-stage";
import { ACTION_META, MORE_ACTIONS, PRIMARY_ACTIONS } from "../web/features/fleet/fleet-meta";
import { stateBadge, draftProblem } from "../web/features/lend/lend-quota-model";
import { warnTexts, type WarnItem } from "../web/features/lend/quota-warning-model";
import { lpBadgeText, type LpState } from "../web/lib/api/fleet";
import {
  BANNED_OWNER_WORDS, LEND_WORDS, LP_WORDS, MACHINE_WORDS, READY_WORD, STAGE_WORD, STEP_WORD, ownerWordEn, ownerWordsTr, stageWord,
} from "../web/lib/owner-words";

const STAGES = {
  spec: "规格", restate: "确认需求", build: "开发", review: "审查", fix: "返工", merge: "合并",
  live: "上线", verified: "验证", done: "完成", blocked: "受阻", cancelled: "取消",
};
const TABLES = [STAGE_WORD, STEP_WORD, MACHINE_WORDS, LP_WORDS, LEND_WORDS, { ready: READY_WORD }];
const allZh = TABLES.flatMap((table) => Object.values(table));
const banned = (text: string) => BANNED_OWNER_WORDS.filter((w) => text.includes(w));

describe("阶段与步骤", () => {
  test("11 个已知阶段键照词表；未知键、原型上的键都是「其他」，不露英文键", () => {
    expect(STAGE_WORD).toEqual(STAGES);
    for (const [key, word] of Object.entries(STAGES)) expect(stageWord(key)).toBe(word);
    for (const key of ["parked", "triage", "", "constructor", "__proto__", "toString"]) expect(stageWord(key)).toBe("其他");
  });
  test("STEP_WORD 覆盖 token 账现有的全部步骤键，STEP_LABELS 的词就是词表里的词，且都有英文", () => {
    expect(Object.keys(STEP_LABELS).sort()).toEqual(["final_review", "fix", "merge", "restate", "review", "ui_check", "verify", "write"]);
    for (const [key, word] of Object.entries(STEP_LABELS)) {
      expect({ key, word }).toEqual({ key, word: STEP_WORD[key] });
      expect(AGENT_USAGE_WORDS[word]).toBeTruthy();
    }
    expect(STEP_WORD).toMatchObject({ restate: "确认需求", write: "开发", review: "审查", fix: "返工", deploy: "部署", publishing: "交付中" });
    expect(READY_WORD).toBe("可以开工");
  });
  test("侧栏阶段芯片：restate 显示「确认需求」「等确认需求」，色调与图标不变", () => {
    const view = stageChipView({ id: "T5", stage: "restate", round: 0 }, "zh");
    expect(view).toMatchObject({ short: "确认需求", state: "等确认需求", tone: "warning", icon: "wait", round: null });
    expect(banned(JSON.stringify(stageChipView({ id: "T5", stage: "restate", round: 0 }, "en")))).toEqual([]);
  });
});

describe("词表不含禁用词，英文齐全", () => {
  test("每个词的中文、英文都不含禁用词；英文里不出现 LP / feature", () => {
    const en = ownerWordsTr("en");
    for (const zh of allZh) {
      expect({ zh, hit: banned(zh) }).toEqual({ zh, hit: [] });
      expect({ zh, en: ownerWordEn(zh) !== undefined }).toEqual({ zh, en: true });
      expect({ zh, hit: banned(en(zh)) }).toEqual({ zh, hit: [] });
      expect(en(zh)).not.toMatch(/\bLP\b|feature/i);
    }
  });
  test("译文的 {占位} 与原文一致；ownerWordsTr 填变量，不认识的词原样返回", () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    for (const zh of allZh) expect({ zh, holes: holes(ownerWordEn(zh)!) }).toEqual({ zh, holes: holes(zh) });
    expect(ownerWordsTr("zh")(LEND_WORDS.grantLine, { slots: "Codex 3", n: 50 })).toBe("同时 Codex 3 个 · 每天 50 个");
    expect(ownerWordsTr("en")(LEND_WORDS.grantLine, { slots: "Codex 3", n: 50 })).toBe("Codex 3 at once · 50 per day");
    expect(ownerWordsTr("en")("词表里没有的")).toBe("词表里没有的");
    expect(ownerWordEn("constructor")).toBeUndefined();
  });
});

describe("low-priority", () => {
  const lp = (over: Partial<LpState>): LpState => ({ lowPriority: "off", walled: false, ...over } as LpState);
  test("徽章文案换词，返回 null 的条件和改前一样", () => {
    expect(lpBadgeText(lp({ lowPriority: "on", resetsAt: "15:00" }))).toBe("排队→15:00");
    expect(lpBadgeText(lp({ lowPriority: "on" }))).toBe("排队→?");
    expect(lpBadgeText(lp({ lowPriority: "exhausted", walled: true }))).toBe("低优先级用完");
    expect(lpBadgeText(lp({ walled: true }))).toBe("额度用完，等重置");
    for (const none of [null, undefined, lp({}), lp({ lowPriority: "unknown" as LpState["lowPriority"] })]) expect(lpBadgeText(none)).toBeNull();
  });
  test("英文徽章不出现 LP", () => {
    const en = ownerWordsTr("en");
    const texts = [lp({ lowPriority: "on", resetsAt: "15:00" }), lp({ lowPriority: "exhausted" }), lp({ walled: true })].map((s) => lpBadgeText(s, en));
    expect(texts).toEqual(["Queued→15:00", "Low priority used up", "Limit hit, waiting for reset"]);
  });
  test("批量面板：动作 id 与分组不变，label / hint 换词", () => {
    expect(Object.keys(ACTION_META)).toEqual(["lp-compact", "lp-off", "compact", "lp-on", "save-compact", "text"]);
    expect([PRIMARY_ACTIONS, MORE_ACTIONS]).toEqual([["lp-compact", "lp-off", "compact"], ["lp-on", "save-compact", "text"]]);
    expect([ACTION_META["lp-compact"].label, ACTION_META["lp-off"].label, ACTION_META["lp-on"].label]).toEqual(["转低优先级再压缩", "关低优先级", "开低优先级"]);
    for (const meta of Object.values(ACTION_META)) expect(banned(meta.label + meta.hint)).toEqual([]);
  });
});

describe("借出", () => {
  test("额度线状态、表单提示、提醒条状态句都不含禁用词", () => {
    const badges = [stateBadge({ state: "stop", limit: "zero", mode: "on" }), stateBadge({ state: "stop", limit: "none", mode: "observe" })].map((b) => b.text);
    expect(badges).toEqual(["已不再接新活", "超过不再接新活的线（未执行）"]);
    expect(draftProblem({ warn: "90", stop: "80" })).toBe("提醒线要低于不再接新活的线");
    const item = (over: Partial<WarnItem>): WarnItem => ({ family: "codex", key: "k", level: "stop", usedPct: 82, resetAt: 1, stopped: true, enforced: true, lastKnown: false, ...over });
    const all = [item({}), item({ stopped: false }), item({ level: "warn", stopped: false }), item({ level: "warn", stopped: false, enforced: false })].map(warnTexts);
    expect(all.map((x) => x.status)).toEqual(["已不再接新活，在跑的活照常做完", "只观察：没停，仍在接新活", "仍在接新活，能同时跑的数量已减半", "只观察：仍在接新活，能同时跑的数量没减"]);
    expect(banned(JSON.stringify(all))).toEqual([]);
  });
});

describe("A 段文件里没有第二份叫法", () => {
  const FILES = ["chat/ledger-stage.ts", "chat/agent-usage-i18n.ts", "fleet/fleet-meta.ts", "fleet/lp-badge.tsx", "lend/lend-panel.tsx", "lend/lent-orders.tsx",
    "lend/grant-form.tsx", "lend/lend-i18n.ts", "lend/lend-quota-settings.tsx", "lend/lend-quota-model.ts", "lend/lend-quota-i18n.ts",
    "lend/quota-warning-model.ts", "lend/quota-warning-i18n.ts", "borrow/borrow-alloc.tsx", "borrow/borrow-bits.tsx"];
  /** 去掉注释后的源码：注释里讲 bridge 侧概念的旧词不算界面文案 */
  const code = (file: string) => readFileSync(new URL(`../web/features/${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  test("字符串字面量里不再有旧词", () => {
    const old = /["'`][^"'`\n]*(复述|名额|停接线|家族|撞墙|新单|借出[中的]*单|开 LP|关 LP|LP 已用完|LP→)[^"'`\n]*["'`]/;
    for (const file of FILES) expect({ file, hit: code(file).match(old)?.[0] ?? null }).toEqual({ file, hit: null });
  });
});
