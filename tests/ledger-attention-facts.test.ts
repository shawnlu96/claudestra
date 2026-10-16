/**
 * 看板卡住判定要的卡级事实（src/lib/ledger-attention-facts.ts）：冻结名单、live 卡观察期截止（从当前这次进 live 起算）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { attentionFacts, type AttentionCtx } from "../src/lib/ledger-attention-facts";
import type { LedgerEvent, Stage } from "../src/lib/ledger-stages";
import { projectMapConfig } from "../src/lib/project-map-config";

const H = 3600_000;
const T0 = new Date(2026, 9, 16, 9).getTime();
let seq = 0;
const ev = (kind: LedgerEvent["kind"], ts: number, data: Record<string, unknown>): LedgerEvent =>
  ({ seq: ++seq, ts, actor: "x", project: "p", target: "C1", kind, text: "", data, dedupKey: null });
const created = ev("task", T0 - 10 * H, { op: "new", patch: { stage: "spec" } });
const toStage = (from: Stage, to: Stage, ts: number, data: Record<string, unknown> = {}) => ev("stage", ts, { from, to, ...data });

const spec = (firstLine: string) => `# C1\n\n## 目标\n做点事\n\n## 上线后 PM\n${firstLine}\n看指标\n\n## 其它\n观察期：1 小时\n`;
const ctx = (text: string | null, frozen: string[] = []): AttentionCtx => ({ frozen: new Set(frozen), spec: () => text });

describe("冻结", () => {
  test("名单里的卡任何阶段都带 frozen；不在名单的不带", () => {
    for (const stage of ["review", "merge", "live", "spec"] as Stage[]) {
      expect(attentionFacts({ id: "C1", stage }, [created], ctx(null, ["C1"]))).toEqual({ frozen: true });
      expect(attentionFacts({ id: "C1", stage }, [created], ctx(null, ["C2"]))).toBeUndefined();
    }
  });

  test("冻结名单读失败（坏 JSON / 不存在）= 空名单，不会把卡都当冻结", () => {
    const dir = mkdtempSync(join(tmpdir(), "attn-facts-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    for (const path of [bad, join(dir, "missing.json")]) {
      const frozen = projectMapConfig("p", path).frozen;
      expect(frozen.size).toBe(0);
      expect(attentionFacts({ id: "C1", stage: "review" }, [created], { frozen, spec: () => null })).toBeUndefined();
    }
  });
});

describe("观察期截止", () => {
  const live = [created, toStage("spec", "merge", T0 - 5 * H), toStage("merge", "live", T0)];

  test("live 卡首行「观察期：24 小时」：截止 = 进 live 时刻 + 24 小时", () => {
    expect(attentionFacts({ id: "C1", stage: "live" }, live, ctx(spec("观察期：24 小时")))).toEqual({ observationUntil: T0 + 24 * H });
    expect(attentionFacts({ id: "C1", stage: "live" }, live, ctx(spec("观察期：24 小时"), ["C1"]))).toEqual({ frozen: true, observationUntil: T0 + 24 * H });
  });

  test("起点是当前这次进 live，不是第一次 live / verified", () => {
    const again = [...live, toStage("live", "verified", T0 + H), toStage("verified", "live", T0 + 30 * H)];
    expect(attentionFacts({ id: "C1", stage: "live" }, again, ctx(spec("观察期：24 小时")))?.observationUntil).toBe(T0 + 54 * H);
  });

  test("首行是散文 / 格式不对 / 没有该节 / 规格读不到 / 不是 live：不给", () => {
    for (const text of [spec("上线后看下指标，观察期大概一天"), spec("观察期：一天"), spec("观察期：0 小时"), "# C1\n\n## 目标\n做点事\n", null]) {
      expect(attentionFacts({ id: "C1", stage: "live" }, live, ctx(text))).toBeUndefined();
    }
    for (const stage of ["merge", "review", "verified", "blocked"] as Stage[]) {
      expect(attentionFacts({ id: "C1", stage }, live, ctx(spec("观察期：24 小时")))).toBeUndefined();
    }
  });

  test("起点不知道：没有进 live 的事件、最后一段不是 live、导入推断的近似时间，都不猜", () => {
    const text = spec("观察期：24 小时");
    expect(attentionFacts({ id: "C1", stage: "live" }, [], ctx(text))).toBeUndefined();
    expect(attentionFacts({ id: "C1", stage: "live" }, [created], ctx(text))).toBeUndefined();
    const approx = [created, toStage("merge", "live", T0, { approxTime: true })];
    expect(attentionFacts({ id: "C1", stage: "live" }, approx, ctx(text))).toBeUndefined();
  });

  test("观察期超过 168 小时按 168 算（与上线后提醒同一解析）", () => {
    expect(attentionFacts({ id: "C1", stage: "live" }, live, ctx(spec("观察期：500 小时")))?.observationUntil).toBe(T0 + 168 * H);
  });
});
