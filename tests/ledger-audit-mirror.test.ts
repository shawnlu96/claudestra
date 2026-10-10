/**
 * team-project-N8B7：共享镜像推送连续失败报给 PM（src/lib/ledger-audit-mirror.ts，规则 mirror_push_failing）。
 * 夹具是真台账库 + 真镜像状态文件 + 真取数（collectAuditSnapshots 经 mirrorDir 读 shared-ledger-mirrors.json）+ 真规则（auditLedger）
 * + 真对账（reconcileFindings），开关用注入的恢复策略 auditMirrorPush。「改动前」= main 上没有这条规则（不在 evaluated、不出条目）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditResult } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { MIRROR_PUSH_FAILURES, readMirrorPush } from "../src/lib/ledger-audit-mirror.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_KEYS, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { SOURCE_DAG_REASONS } from "../src/lib/shared-ledger-source-dag-push.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const NOW = 100_000 * MIN;
const P = "p";
const F = "o1-feat";
const RULE = "mirror_push_failing";
/** 被外发闸拦下的版本说明原文：只在 DAG 版本里，状态文件只有固定理由，条目里不能出现 */
const SECRET = "版本说明里的长串 Zq8xK2pLm9Vt4RwYb7Nc";

let db: Database, path: string, dir: string;
beforeEach(() => {
  path = tempLedgerPath("ledger-audit-mirror-");
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-mirror-"));
  db = openLedger(path);
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: ["agent-pm"] });
  baselineAudit(db, P);
  db.prepare("INSERT INTO features (id, project, title, ownerWords, status, currentVersion, rev, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'active', ?, 1, 'owner', 0, 0)")
    .run(F, P, `feature ${SECRET}`, "", 141);
});
afterEach(() => closeLedger(path));

const policyOf = (mode: RecoveryMode | "throw"): RecoveryPolicyPort => (_p, key) => {
  if (mode === "throw") throw new Error("策略文件坏了");
  return { mode: key === "auditMirrorPush" ? mode : "observe", manualAfterMs: null, source: "config" };
};

type Over = { dagError?: { reason: string; at: number; failures: number; nextAttemptAt: number } | null; lastError?: string | null;
  failures?: number; lastPushSeq?: number | null; enabled?: boolean; localProject?: string };
function writeMirrors(over: Over, extra: Record<string, unknown> = {}): void {
  const entry = {
    enabled: over.enabled ?? true, batchId: "b1", centerId: "c1", teamId: "t1", projectId: "pj1", centerFeatureId: "cf1", sourceInstanceId: "i1",
    localProject: over.localProject ?? P, watermark: 10, snapshot: false, fingerprints: {}, taskMeta: {},
    lastPushAt: 1, lastPushSeq: over.lastPushSeq === undefined ? 10 : over.lastPushSeq,
    lastError: over.lastError ?? null, lastErrorAt: over.lastError ? NOW - 5 * MIN : null, failures: over.failures ?? 0, nextAttemptAt: 0,
    dagVersion: 140, dagError: over.dagError ?? null,
  };
  writeFileSync(join(dir, "shared-ledger-mirrors.json"), JSON.stringify({ features: { [F]: entry, ...extra } }));
}
const dagFail = (failures: number, reason: string = SOURCE_DAG_REASONS.blocked) => ({ dagError: { reason, at: NOW - 3 * MIN, failures, nextAttemptAt: NOW } });

const sources = (mirrorDir: string | undefined = dir): SnapshotSources => ({
  registry: async () => [], windows: async () => ["master"], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json"),
  ...(mirrorDir ? { mirrorDir } : {}),
});
async function run(mode: RecoveryMode | "throw", src = sources()): Promise<AuditResult> {
  const [s] = await collectAuditSnapshots(db, [P], NOW, src);
  return auditLedger(s!, NOW, policyOf(mode));
}
const mine = (r: AuditResult) => r.findings.filter((f) => f.rule === RULE);
const others = (r: AuditResult) => ({
  findings: r.findings.filter((f) => f.rule !== RULE), evaluated: r.evaluated.filter((x) => x !== RULE), skipped: r.skipped.filter((x) => x.rule !== RULE),
});

describe("[验收线 1] DAG 类", () => {
  test("failures=3、固定理由：on 下报一条，detail 含 featureId 与次数、不含版本说明原文；旧路径（快照不带镜像）没有这条规则", async () => {
    writeMirrors(dagFail(3));
    const r = await run("on");
    expect(mine(r)).toHaveLength(1);
    const f = mine(r)[0]!;
    expect(f.detail).toBe(`${F} 共享镜像DAG推送连续失败 3 次：${SOURCE_DAG_REASONS.blocked}`);
    expect(f.suggestion).toBe(`ledger shared-mirror status ${F} 看详情；理由是含不能外发的内容时，查最新 DAG 版本说明和节点文字里的长串、绝对路径，PM 改自己的文字后重写一版，不改外发闸`);
    expect(f.key).toBe(`${P}|${RULE}|${F}|dag|${SOURCE_DAG_REASONS.blocked}|141`);
    expect(f.taskId).toBeNull();
    expect(f.notify).toBe("agent-pm");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.evaluated).toContain(RULE);
    // 旧红：同一夹具，快照不读镜像（= main 上的取数与规则）→ 没有条目、没有这条规则
    const old = await run("on", sources(""));
    expect(mine(old)).toHaveLength(0);
    expect(old.evaluated).not.toContain(RULE);
  });

  test("failures=2 不报，仍 evaluated", async () => {
    writeMirrors(dagFail(MIRROR_PUSH_FAILURES - 1));
    const r = await run("on");
    expect(mine(r)).toHaveLength(0);
    expect(r.evaluated).toContain(RULE);
  });

  test("别的项目的、已停镜像的 feature 不报", async () => {
    writeMirrors({ ...dagFail(5), localProject: "other" });
    expect(mine(await run("on"))).toHaveLength(0);
    writeMirrors({ ...dagFail(5), enabled: false });
    expect(mine(await run("on"))).toHaveLength(0);
  });
});

describe("[验收线 2] 投影类", () => {
  test("lastError 有值且 failures=3 报；key 用 lastPushSeq", async () => {
    writeMirrors({ lastError: "center rejected (403)", failures: 3, lastPushSeq: 77 });
    const r = await run("on");
    expect(mine(r).map((f) => [f.detail, f.key])).toEqual([[`${F} 共享镜像投影推送连续失败 3 次：center rejected (403)`, `${P}|${RULE}|${F}|projection|center rejected (403)|77`]]);
  });

  test("lastError 为 null 不报", async () => {
    writeMirrors({ lastError: null, failures: 3 });
    expect(mine(await run("on"))).toHaveLength(0);
  });

  test("投影与 DAG 两类分开报", async () => {
    writeMirrors({ lastError: "center unavailable; outcome unconfirmed", failures: 4, lastPushSeq: null, ...dagFail(3) });
    expect(mine(await run("on")).map((f) => f.key.split("|")[3])).toEqual(["projection", "dag"]);
  });
});

describe("[验收线 3] 去重", () => {
  test("同一版本号再跑一轮不重复推；本机版本号变了、又失败满 3 次算新的一条", async () => {
    const round = async () => {
      const r = await run("on");
      const rec = reconcileFindings(db, P, r.findings, r.evaluated, NOW);
      return rec.pending.filter((f) => f.rule === RULE).map((f) => f.key);
    };
    writeMirrors({}); // 本规则先建基线（生产上由缺省 observe 建；没基线时首轮会被 silenceFirstRun 记成已推）
    expect(await round()).toEqual([]);
    writeMirrors(dagFail(3));
    const first = await round();
    expect(first).toHaveLength(1);
    db.prepare("UPDATE audit_findings SET notifiedAt = ? WHERE key = ?").run(NOW, first[0]);
    writeMirrors(dagFail(9)); // 同一段失败、次数涨了：同一个 key，不再推
    expect(await round()).toEqual([]);
    // 推成功：dagError 清空，本机版本号随新版本前进；旧条目结清
    db.prepare("UPDATE features SET currentVersion = 142 WHERE id = ?").run(F);
    writeMirrors({ dagError: null });
    expect(await round()).toEqual([]);
    writeMirrors(dagFail(3));
    const next = await round();
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(first[0]);
    expect(next[0]).toEndWith("|142");
  });
});

describe("[验收线 4] 开关与读失败", () => {
  test("RECOVERY_KEYS 里恰好有一个 auditMirrorPush", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "auditMirrorPush")).toHaveLength(1);
  });

  test("off（含策略读不了）：不评估", async () => {
    writeMirrors(dagFail(3));
    for (const mode of ["off", "throw"] as const) {
      const r = await run(mode);
      expect(mine(r)).toHaveLength(0);
      expect(r.evaluated).not.toContain(RULE);
      expect(r.skipped.filter((x) => x.rule === RULE)).toEqual([]);
    }
  });

  test("observe：不进 findings、不推；evaluated 建基线；skipped 里标「观察中」（dry-run 可见）", async () => {
    writeMirrors(dagFail(3));
    const r = await run("observe");
    expect(mine(r)).toHaveLength(0);
    expect(r.evaluated).toContain(RULE);
    expect(r.skipped.filter((x) => x.rule === RULE)).toEqual([{ rule: RULE, reason: `观察中：${F} 共享镜像DAG推送连续失败 3 次：${SOURCE_DAG_REASONS.blocked}` }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const rec = reconcileFindings(db, P, r.findings, r.evaluated, NOW);
    expect(rec.pending.filter((f) => f.rule === RULE)).toEqual([]);
    // 切 on：基线已在，首轮照推，不被首轮静默吞掉
    const on = await run("on");
    const rec2 = reconcileFindings(db, P, on.findings, on.evaluated, NOW);
    expect(rec2.pending.filter((f) => f.rule === RULE)).toHaveLength(1);
    expect(rec2.silenced).toEqual([]);
  });

  test("状态文件坏了 / 读不了：本规则 skipped，其他规则结果不变", async () => {
    writeMirrors({});
    const good = await run("on");
    writeFileSync(join(dir, "shared-ledger-mirrors.json"), "{ not json");
    const bad = await run("on");
    expect(bad.evaluated).not.toContain(RULE);
    expect(bad.skipped.filter((x) => x.rule === RULE)).toEqual([{ rule: RULE, reason: "共享镜像状态文件读不了或已损坏" }]);
    expect(others(bad)).toEqual(others(good));
    writeFileSync(join(dir, "shared-ledger-mirrors.json"), JSON.stringify({ features: { [F]: { enabled: "yes" } } })); // 结构不对
    expect(readMirrorPush(db, P, dir)).toMatchObject({ unreadable: "共享镜像状态文件读不了或已损坏" });
  });

  test("没有状态文件：评估、无条目", async () => {
    const r = await run("on");
    expect(r.evaluated).toContain(RULE);
    expect(mine(r)).toHaveLength(0);
  });
});

describe("第 1 轮审查回归", () => {
  const round = async (mode: RecoveryMode) => {
    const r = await run(mode);
    const rec = reconcileFindings(db, P, r.findings, r.evaluated, NOW, { keep: r.keep });
    return { r, rec, pending: rec.pending.filter((f) => f.rule === RULE).map((f) => f.key) };
  };

  test("[验收线 3] on → ack → observe → on：同一段失败不被 observe 结清、切回 on 不重推", async () => {
    writeMirrors({});
    await round("on"); // 建基线
    writeMirrors(dagFail(3));
    const first = await round("on");
    expect(first.pending).toHaveLength(1);
    db.prepare("UPDATE audit_findings SET notifiedAt = ? WHERE key = ?").run(NOW, first.pending[0]);
    const obs = await round("observe");
    expect(obs.rec.resolved).not.toContain(first.pending[0]);
    expect(obs.pending).toEqual([]);
    const again = await round("on");
    expect(again.rec.opened).toEqual([]);
    expect(again.pending).toEqual([]);
  });

  test("[验收线 4] on 时落库没送达的，observe 下不发；observe 下已恢复的照常结清", async () => {
    writeMirrors({});
    await round("on");
    writeMirrors(dagFail(3));
    const first = await round("on");
    expect(first.pending).toHaveLength(1);
    expect((await round("observe")).pending).toEqual([]);
    writeMirrors({ dagError: null });
    expect((await round("observe")).rec.resolved).toEqual(first.pending);
  });

  test("[验收线 4] 本规则消费的字段坏了：unreadable、本规则 skipped、旧发现不被结清、其他规则不变、对账不抛", async () => {
    writeMirrors({});
    const good = await round("on");
    writeMirrors(dagFail(3));
    const open = (await round("on")).pending;
    expect(open).toHaveLength(1);
    const bads: Over[] = [
      { dagError: {} as never },
      { dagError: { ...dagFail(3).dagError, failures: "broken" as never } },
      { dagError: { ...dagFail(3).dagError, at: { corrupt: true } as never } },
      { dagError: { ...dagFail(3).dagError, reason: "" } },
      { lastError: 123 as never, failures: 3 },
      { lastPushSeq: "x" as never },
    ];
    for (const over of bads) {
      writeMirrors(over);
      expect(readMirrorPush(db, P, dir)).toMatchObject({ unreadable: "共享镜像状态文件读不了或已损坏" });
      const bad = await round("on");
      expect(bad.r.evaluated).not.toContain(RULE);
      expect(bad.r.skipped.filter((x) => x.rule === RULE)).toEqual([{ rule: RULE, reason: "共享镜像状态文件读不了或已损坏" }]);
      expect(bad.rec.resolved).toEqual([]);
      expect(others(bad.r)).toEqual(others(good.r));
    }
  });

  test("[验收线 4] 旧状态没有 dagError 字段：照常评估、不当成损坏", async () => {
    writeMirrors({});
    const raw = JSON.parse(readFileSync(join(dir, "shared-ledger-mirrors.json"), "utf8"));
    delete raw.features[F].dagError;
    writeFileSync(join(dir, "shared-ledger-mirrors.json"), JSON.stringify(raw));
    const r = await run("on");
    expect(r.evaluated).toContain(RULE);
    expect(mine(r)).toHaveLength(0);
  });
});

describe("第 2 轮审查回归", () => {
  const round = async (mode: RecoveryMode) => {
    const r = await run(mode);
    const rec = reconcileFindings(db, P, r.findings, r.evaluated, NOW, { keep: r.keep });
    return { r, rec, pending: rec.pending.filter((f) => f.rule === RULE).map((f) => f.key) };
  };
  const otherPending = (rec: { pending: { rule: string; key: string }[] }) => rec.pending.filter((f) => f.rule !== RULE).map((f) => f.key);
  /** on 下 DAG 连续失败 3 次落库、不 ack（PM 离线 / 投递失败）；顺带放一条别的规则的待发提醒 */
  async function undelivered(): Promise<string> {
    writeMirrors({});
    await round("observe"); // 建基线
    writeMirrors(dagFail(3));
    const first = await round("on");
    expect(first.pending).toHaveLength(1);
    db.prepare(`INSERT INTO audit_findings (key, project, taskId, rule, firstSeen, lastSeen, since, detail, suggestion, notify, changedAt)
      VALUES ('p|owner_inbox_stale|x', ?, NULL, 'owner_inbox_stale', ?, ?, ?, 'd', 's', 'agent-pm', ?)`).run(P, NOW, NOW, NOW, NOW);
    return first.pending[0]!;
  }

  test("[验收线 4] 落库未 ack → observe → 状态损坏：不推、不结清、keep 住；其他规则的待发照旧", async () => {
    const key = await undelivered();
    const healthy = await round("observe");
    expect(healthy.pending).toEqual([]);
    expect(healthy.r.keep).toContain(key);
    for (const corrupt of ["{ not json", JSON.stringify({ features: { [F]: { ...JSON.parse(readFileSync(join(dir, "shared-ledger-mirrors.json"), "utf8")).features[F], dagError: {} } } })]) {
      writeFileSync(join(dir, "shared-ledger-mirrors.json"), corrupt);
      const bad = await round("observe");
      expect(bad.r.evaluated).not.toContain(RULE);
      expect(bad.r.skipped.filter((x) => x.rule === RULE)).toEqual([{ rule: RULE, reason: "共享镜像状态文件读不了或已损坏" }]);
      expect(bad.r.keep).toContain(key);
      expect(bad.pending).toEqual([]);
      expect(bad.rec.resolved).toEqual([]);
      expect(otherPending(bad.rec)).toEqual(["p|owner_inbox_stale|x"]);
    }
  });

  test("[验收线 4] off 下同样不发旧的待发提醒；切回 on、状态损坏时照常推（on = 推送）", async () => {
    const key = await undelivered();
    const off = await round("off");
    expect(off.r.evaluated).not.toContain(RULE);
    expect(off.pending).toEqual([]);
    expect(off.rec.resolved).toEqual([]);
    expect(otherPending(off.rec)).toEqual(["p|owner_inbox_stale|x"]);
    writeFileSync(join(dir, "shared-ledger-mirrors.json"), "{ not json");
    const on = await round("on");
    expect(on.r.keep).not.toContain(key);
    expect(on.pending).toEqual([key]);
  });
});
