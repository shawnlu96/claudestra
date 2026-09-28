/** web/features/chat/ledger-stage.ts：侧栏行尾台账阶段小标的标签 / 色调 / 整句；lib/chat/agents.ts 的 ledgerTask 守卫与轮询签名 */
import { describe, expect, test } from "bun:test";
import { stageChipView, stageSentence, taskIdInName } from "@/features/chat/ledger-stage";
import { agentExtraSig, parseLedgerTask } from "@/lib/chat/agents";
import { DICT } from "@/lib/i18n-dict";
import { fillParams } from "@/lib/i18n-fill";
import { STAGES } from "../src/lib/ledger-stages";

const zh = (s: string, p?: Record<string, string | number>) => fillParams(s, p);
const en = (s: string, p?: Record<string, string | number>) => fillParams(DICT[s] ?? s, p);
const view = (stage: string, round = 0, id = "T5", lang: "zh" | "en" = "zh") => stageChipView({ id, stage, round }, lang);

describe("stageChipView", () => {
  test("规格卡的四个样例：T5 返工 R1、T6a 审查 R2、T12b 开发、T1 合并", () => {
    expect(view("fix", 1)).toMatchObject({ short: "返工", tone: "error", round: 1 });
    expect(view("review", 2, "T6a")).toMatchObject({ short: "审查", tone: "warning", round: 2, id: "T6a" });
    expect(view("build", 0, "T12b")).toMatchObject({ short: "开发", tone: "primary", round: null });
    expect(view("merge", 2, "T1")).toMatchObject({ short: "合并", tone: "warning", round: null });
  });
  test("色调：返工 / 卡住红，等待类黄，开发主色，验证绿", () => {
    const tones = Object.fromEntries(["spec", "restate", "build", "review", "fix", "merge", "live", "verified", "blocked"].map((s) => [s, view(s, 1).tone]));
    expect(tones).toEqual({
      spec: "neutral", restate: "warning", build: "primary", review: "warning", fix: "error",
      merge: "warning", live: "warning", verified: "success", blocked: "error",
    });
  });
  test("轮次只挂在审查 / 返工上，第 0 轮、负数、小数都不显示", () => {
    expect(view("review", 0).round).toBeNull();
    expect(view("build", 3).round).toBeNull();
    expect(view("blocked", 2).round).toBeNull();
    expect(view("fix", -1).round).toBeNull();
    expect(view("review", 1.5).round).toBeNull();
  });
  test("src 的每个阶段都有中英文人话短名和状态句（bridge 加了阶段这里要跟上）", () => {
    for (const s of STAGES) {
      const z = view(s, 0, "T5", "zh");
      expect([z.short, z.state]).not.toContain(s);
      expect(view(s, 0, "T5", "en").short).not.toBe(s); // 英文状态句可以和阶段名同形（verified），短名首字母大写一定不同
    }
  });
  test("认不出的阶段、原型上的键：原样显示、中性色，不抛错", () => {
    expect(view("triage", 1)).toMatchObject({ short: "triage", state: "triage", tone: "neutral", round: null });
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(view(k)).toMatchObject({ short: k, state: k, tone: "neutral" });
    }
  });
});

describe("stageSentence", () => {
  test("悬停 / 长按 / 读屏的整句，中英", () => {
    expect(stageSentence(view("fix", 1), zh)).toBe("T5 · 返工中 · 第 1 轮");
    expect(stageSentence(view("build", 0, "T12b"), zh)).toBe("T12b · 开发中");
    expect(stageSentence(view("fix", 1, "T5", "en"), en)).toBe("T5 · fixing · round 1");
    expect(stageSentence(view("live", 0, "T5", "en"), en)).toBe("T5 · live, awaiting verification");
  });
  test("阶段短词不进全局字典（撞键会改掉别处的译文）", () => {
    for (const k of ["开发", "验证", "审查", "合并", "上线", "卡住"]) expect(DICT[k]).toBeUndefined();
  });
});

describe("taskIdInName", () => {
  test("显示名或会话名里按词带着任务号就不重复显示", () => {
    expect(taskIdInName(["task-t12b"], "T12b")).toBe(true);
    expect(taskIdInName([null, "task-t5"], "T5")).toBe(true);
    expect(taskIdInName(["修复弹窗", "task-t5"], "T5")).toBe(true); // label 不带，行上「| task-t5」带
    expect(taskIdInName(["task-t12"], "T12b")).toBe(false);
    expect(taskIdInName(["task-t12b"], "T12")).toBe(false);
    expect(taskIdInName([undefined, "reviewer"], "T5")).toBe(false);
  });
});

describe("parseLedgerTask（GET /agents 的 ledgerTask 不可信）", () => {
  test("缺 id / 缺 stage / 类型不对 → 当没挂任务，不让一行坏数据把整个侧栏渲染崩", () => {
    for (const raw of [{}, { id: "T5" }, { stage: "fix", round: 1 }, { id: 5, stage: "fix" }, { id: "T5", stage: 3 }, { id: "", stage: "fix" }, "T5", 1, null, undefined, []]) {
      expect(parseLedgerTask(raw)).toBeNull();
    }
  });
  test("round 不是整数按 0；多余字段丢掉", () => {
    expect(parseLedgerTask({ id: "T5", stage: "fix" })).toEqual({ id: "T5", stage: "fix", round: 0 });
    expect(parseLedgerTask({ id: "T5", stage: "fix", round: "2" })).toEqual({ id: "T5", stage: "fix", round: 0 });
    expect(parseLedgerTask({ id: "T5", stage: "fix", round: 2, x: 1 })).toEqual({ id: "T5", stage: "fix", round: 2 });
  });
  test("stage 是原型键也能走到渲染而不抛错", () => {
    const lt = parseLedgerTask({ id: "T5", stage: "constructor", round: 1 })!;
    expect(stageSentence(stageChipView(lt, "zh"), zh)).toBe("T5 · constructor");
  });
});

describe("列表轮询签名", () => {
  // agentsSignature 漏字段 = 轮询判「没变」、小标不更新
  test("ledgerTask 的任务号 / 阶段 / 轮次任一变化都改签名，没有时不改", () => {
    const base = { name: "task-t5", displayName: "task-t5", purpose: "", cwd: "", status: "active" as const };
    const sig = (ledgerTask?: { id: string; stage: string; round: number } | null) => agentExtraSig({ ...base, ledgerTask });
    const a = sig({ id: "T5", stage: "fix", round: 1 });
    expect(sig({ id: "T5", stage: "review", round: 1 })).not.toBe(a);
    expect(sig({ id: "T5", stage: "fix", round: 2 })).not.toBe(a);
    expect(sig({ id: "T6", stage: "fix", round: 1 })).not.toBe(a);
    expect(sig(null)).not.toBe(a);
    expect(sig(null)).toBe(sig(undefined));
  });
});
