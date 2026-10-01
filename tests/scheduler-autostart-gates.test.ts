/**
 * i28-A1 §1–2 开卡的门（验收线 2 / 4 的判定部分）：纯函数（卡首解析、静置窗口、arm、额度线）与临时台账上的表驱动门。
 * 每条门单独拧一下，候选就得变成那道门的拦截；全部放开时才是候选。claim 事务里的重核在 tests/ledger-autostart-claim.test.ts。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureLanes } from "../src/lib/dag-tools-lanes.js";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { rewriteDag } from "../src/lib/ledger-dag-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag, setFeature } from "../src/lib/ledger-feature-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setFrozen, setMeta } from "../src/lib/ledger-write.js";
import {
  armOf, currentViews, featureGate, isStop, nodeCandidate, parseSpecHead, quotaOver, specGate, SPEC_SETTLE_MS, TEMPLATE_VERSION, type ServiceFacts, type SpecFile,
} from "../src/lib/scheduler-autostart.js";
import { templateFor } from "../src/lib/scheduler-template.js";

const P = "claude-orchestrator", PM = "agent-pm";
let dir: string, db: Database, now: number, svc: ServiceFacts;
let specs: Record<string, SpecFile>;

const ctx = (actor = PM) => ({ actor, now: now++ });
const FID = "ab12-i28";

function feature(nodes: unknown[]): void {
  createFeature(db, ctx(), { project: P, slug: "i28", title: "协作底座" });
  initDag(db, ctx(), { id: FID, rev: 1, nodes });
}
const node = (key: string, globs: string[], deps: string[] = []) => ({ key, oneLine: `节点 ${key}`, fileGlobs: globs, deps });
const ripe = (text = "# 规格\n模板：code\n\n## 目标\n") => ({ mtimeMs: now - SPEC_SETTLE_MS - 1, text });

/** 节点 key 此刻的结论：候选 → "open"，否则拦它的那道门 */
function verdict(key: string): string {
  const f = getFeature(db, FID)!;
  const shared = featureGate(db, f, svc);
  if (shared) return shared.gate;
  const r = nodeCandidate(db, f, key, featureLanes(db, f), currentViews(db, f), (id) => specs[id] ?? null, now);
  return isStop(r) ? r.gate : "open";
}

beforeEach(() => {
  now = 10_000_000;
  dir = mkdtempSync(join(tmpdir(), "i28-a1-gates-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
  svc = { autoDispatch: true, projects: [P], maxWorkers: () => 3 };
  specs = { "i28-a": ripe(), "i28-b": ripe() };
  feature([node("a", ["src/lib/a*.ts"]), node("b", ["src/lib/b.ts"], ["a"])]);
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("卡首：模板行与开关行", () => {
  const cases: [string, string, unknown][] = [
    ["不写 = code 最高版", "# T\n\n## 目标\n", { ok: true, template: "code", version: TEMPLATE_VERSION.code }],
    ["全角冒号", "# T\n模板：ui\n## 目标\n", { ok: true, template: "ui", version: TEMPLATE_VERSION.ui }],
    ["半角冒号 + 大写", "# T\n模板: Security\n## 目标\n", { ok: true, template: "security", version: TEMPLATE_VERSION.security }],
    ["值不分大小写", "# T\n模板：CODE\n", { ok: true, template: "code", version: TEMPLATE_VERSION.code }],
    ["未知值", "# T\n模板：web\n", { ok: false }],
    ["写了两行（同值也算）", "# T\n模板：ui\n模板：ui\n", { ok: false }],
    ["## 之后的模板行不算卡首", "# T\n## 目标\n模板：ui\n", { ok: true, template: "code", version: TEMPLATE_VERSION.code }],
  ];
  for (const [name, text, want] of cases) test(name, () => expect(parseSpecHead(text).template).toMatchObject(want as object));

  test("模板版本取 scheduler-template.ts 的最高版，不写死", () => {
    for (const t of ["code", "ui", "security"] as const) {
      expect(templateFor(t, TEMPLATE_VERSION[t])).not.toBeNull();
      expect(templateFor(t, TEMPLATE_VERSION[t] + 1)).toBeNull();
    }
  });

  test("「自动开卡：关」只认卡首", () => {
    expect(parseSpecHead("# T\n自动开卡：关\n## 目标\n").off).toBe(true);
    expect(parseSpecHead("# T\n自动开卡: 关\n").off).toBe(true);
    expect(parseSpecHead("# T\n## 目标\n自动开卡：关\n").off).toBe(false);
  });
});

describe("静置窗口与 arm", () => {
  test("60 秒边界：差 1ms 不开，满 60 秒开", () => {
    const t = 1_000_000;
    expect(specGate({ mtimeMs: t - SPEC_SETTLE_MS + 1, text: "# T\n" }, t)).toHaveProperty("why");
    expect(specGate({ mtimeMs: t - SPEC_SETTLE_MS, text: "# T\n" }, t)).toHaveProperty("head");
    expect(specGate(null, t)).toHaveProperty("why");
  });

  test("规格、文件范围、模板任一样变了，arm 就变", () => {
    const a = armOf("x", ["a.ts"], "code");
    expect(armOf("x", ["a.ts"], "code")).toBe(a);
    expect(new Set([a, armOf("y", ["a.ts"], "code"), armOf("x", ["b.ts"], "code"), armOf("x", ["a.ts"], "ui")]).size).toBe(4);
  });
});

describe("额度线（只看 Claude 周窗口）", () => {
  const q = (windows: { kind: string; usedPct: number | null }[], status: "known" | "unknown" = "known"): InventoryQuota =>
    ({ status, source: null, observedAt: 1, plan: null, reason: null, windows: windows.map((w, i) => ({ id: `w${i}`, resetsAtMs: 9, resetPassed: false, ...w })) });
  test.each([
    ["到线拦", [{ kind: "weekly", usedPct: 70 }], true],
    ["线下放", [{ kind: "weekly", usedPct: 69.9 }], false],
    ["weekly_scoped 也算", [{ kind: "weekly_scoped", usedPct: 90 }], true],
    ["会话窗口不算", [{ kind: "session", usedPct: 99 }], false],
    ["用量未知不拦", [{ kind: "weekly", usedPct: null }], false],
  ] as const)("%s", (_n, windows, blocked) => expect(!!quotaOver(q([...windows]), 70)).toBe(blocked));
  test("读不到（unknown）不拦", () => expect(quotaOver(q([{ kind: "weekly", usedPct: 99 }], "unknown"), 70)).toBeNull());
});

describe("台账门（表驱动）：全放开时是候选，拧任一道就拦在那道", () => {
  test("基线：a 能开，b 依赖没满足", () => {
    expect(verdict("a")).toBe("open");
    expect(verdict("b")).toBe("lanes");
  });

  const cases: [string, string, () => void][] = [
    ["规格卡缺", "spec", () => { delete specs["i28-a"]; }],
    ["规格卡静置未满 60 秒", "spec", () => { specs["i28-a"] = { mtimeMs: now - 1000, text: "# T\n" }; }],
    ["卡首写了自动开卡：关", "spec", () => { specs["i28-a"] = ripe("# T\n自动开卡：关\n"); }],
    ["文件和项目里在跑的卡重叠", "lanes", () => void createTask(db, ctx(), { project: P, id: "T9", title: "x", kind: "code", extra: { fileGlobs: ["src/lib/a1.ts"] } })],
    ["队列冻结", "frozen", () => void setFrozen(db, ctx(), { project: P, frozen: true, reason: "x" })],
    ["项目开关关着", "switch", () => void setAutostartSwitch(db, ctx(), { project: P, on: false, reason: "owner 关" })],
    ["feature 开关关着", "switch", () => void setAutostartSwitch(db, ctx(), { project: P, on: false, featureId: FID, reason: "这条先手动" })],
    ["feature 不是 active", "feature", () => void setFeature(db, ctx(), { id: FID, rev: getFeature(db, FID)!.rev, patch: { status: "paused" } })],
    ["有待批的重写提案", "proposal", () => void rewriteDag(db, ctx(), {
      id: FID, rev: getFeature(db, FID)!.rev, nodes: [node("a", ["src/lib/a*.ts"]), node("b", ["src/lib/b.ts"], ["a"]), node("z", ["z.ts"])], reasonKind: "new_issue",
      reasonText: "改范围", cancel: new Map(), scopeChange: true, askFrom: { agent: PM, channelId: null } })],
    ["autoDispatch 关着", "service", () => { svc = { ...svc, autoDispatch: false }; }],
    ["项目没列在 scheduler.json", "service", () => { svc = { ...svc, projects: [] }; }],
    ["容量满（持槽的卡 + auto 没拿槽的卡）", "capacity", () => {
      for (const id of ["T1", "T2", "T3"]) createTask(db, ctx(), { project: P, id, title: id, kind: "code" });
      db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
        VALUES ('i1', 'T3', ?, 'build', 'dispatch', 1, 1, 1, 1, NULL, 3, 'done', 'x', 1, 1)`).run(P);
      // T3 是 manual 但持槽，T1 / T2 是 auto 还没拿槽：合计 3 = maxActiveWorkers
      db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt) VALUES (?, ?, 'T3', 'i1', 1)").run(P, `slot:${P}:1`);
      for (const id of ["T1", "T2", "T3"]) {
        db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
          VALUES (?, ?, 'code', 3, ?, 'claude', 'x', 1, 1, 1)`).run(id, P, id === "T3" ? "manual" : "auto");
      }
    }],
    ["没有 PM（名单里只有调度助理）", "no_pm", () => {
      setMeta(db, { actor: "owner", now: now++ }, { project: P, key: "team", value: { dispatcher: PM, audit: false } });
    }],
    ["同一 arm 已经开过", "armed", () => {
      const text = specs["i28-a"].text;
      db.query("INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (1, 'scheduler', ?, ?, 'feature', '', ?, ?)")
        .run(P, FID, JSON.stringify({ op: "autostart_claim", key: "a" }), `autostart:${FID}:a:${armOf(text, ["src/lib/a*.ts"], "code")}`);
      const seq = (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
      db.query("INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (1, 'scheduler', ?, ?, 'feature', '', '{}', ?)")
        .run(P, FID, `autostart-settle:${seq}`);
    }],
  ];
  for (const [name, gate, twist] of cases) {
    test(name, () => {
      twist();
      expect(verdict("a")).toBe(gate);
    });
  }

  test("文件和本图在做的节点重叠：a 已绑卡在 build，与它重叠的 c 不开", () => {
    rewriteDag(db, ctx(), { id: FID, rev: getFeature(db, FID)!.rev, nodes: [node("a", ["src/lib/a*.ts"]), node("b", ["src/lib/b.ts"], ["a"]), node("c", ["src/lib/a2.ts"])],
      reasonKind: "new_issue", reasonText: "加 c", cancel: new Map(), scopeChange: false, askFrom: { agent: PM, channelId: null } });
    createTask(db, ctx(), { project: P, id: "i28-a", title: "a", kind: "code" });
    db.query("INSERT INTO dag_bindings (featureId, version, nodeKey, taskId, boundBy, boundAt) VALUES (?, 2, 'a', 'i28-a', ?, 1)").run(FID, PM);
    specs["i28-c"] = ripe();
    expect(verdict("c")).toBe("lanes");
  });

  test("已绑卡的节点不是候选", () => {
    createTask(db, ctx(), { project: P, id: "i28-a", title: "a", kind: "code" });
    db.query("INSERT INTO dag_bindings (featureId, version, nodeKey, taskId, boundBy, boundAt) VALUES (?, 1, 'a', 'i28-a', ?, 1)").run(FID, PM);
    expect(verdict("a")).toBe("node");
  });
});
