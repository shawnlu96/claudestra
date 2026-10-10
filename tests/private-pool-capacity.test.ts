/**
 * i28-SECPOOL2 审查 private-capacity / corrupt-warning：开卡前的容量估算按节点自己的仓库算 peer 授权；
 * 公共仓没空位、只授权了私仓的 peer 有空位时，private-pool=on 的私仓节点照样能过 feature 门与 claim 重核，公共仓节点照旧按容量停。
 * 开关损坏按 off，告警带项目名、每个项目只一次。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privatePoolMode, setPrivatePoolMode, type PrivatePoolMode } from "../src/lib/card-repo.js";
import { featureLanes } from "../src/lib/dag-tools-lanes.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { PROJECTS_PATH } from "../src/lib/projects.js";
import { currentViews, featureGate, isStop, ledgerGate, nodeCandidate, SPEC_SETTLE_MS, type ServiceFacts } from "../src/lib/scheduler-autostart.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { autostartCapacity, autostartPlacementGate } from "../src/lib/scheduler-slot-hold-autostart.js";

const P = "claude-orchestrator", FID = "ab12-i28", PRIV = "floka-ai/cloud", PUB = "shawnlu96/claudestra";
const remote: RemotePolicy = { mode: "balance", roles: [], poolTimeoutMin: 15, repo: PUB, agents: { claude: 0, codex: 0 } };
const borrow = [{ peer: "mate", projects: [P], maxOpen: 0, roles: [] }];

let dir: string, db: Database, now: number, projectsBefore: string | null;

function gitRepo(path: string, origin: string): string {
  mkdirSync(path, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", path]);
  Bun.spawnSync(["git", "-C", path, "remote", "add", "origin", origin]);
  return path;
}
const mode = async (m: PrivatePoolMode) => { await setPrivatePoolMode(P, m); };
/** mate 只授权 grantRepos，两家族各 1 个空位 */
const hello = (grantRepos: string[], roles: "write"[] = []) => recordHello(db, "mate", null, { v: 1, proto: 2, boot: "b", seq: 1, paused: null,
  slots: { claude: { total: 1, busy: 0 }, codex: { total: 1, busy: 0 } },
  grant: { until: now + 3_600_000, repos: grantRepos, roles, ordersPerDay: 50, ordersLeftToday: 50 } }, now);
const svc: ServiceFacts = { autoDispatch: true, projects: [P], maxWorkers: () => 0, pool: () => ({ remote, borrow }), now: () => now };

function plan(nodes: { key: string; fileGlobs: string[] }[]): void {
  createFeature(db, { actor: "agent-pm", now: now++ }, { project: P, slug: "i28", title: "协作底座" });
  initDag(db, { actor: "agent-pm", now: now++ }, { id: FID, rev: 1, nodes: nodes.map((n) => ({ ...n, oneLine: `节点 ${n.key}`, deps: [] })) });
}
/** 调度侧的顺序：feature 门 → 节点候选（同一个 feature 对象） */
function pick(key: string): string {
  const f = getFeature(db, FID)!;
  const g = featureGate(db, f, svc);
  if (g) return `${g.gate}:${g.why}`;
  const r = nodeCandidate(db, f, key, featureLanes(db, f), currentViews(db, f), () => ({ mtimeMs: now - SPEC_SETTLE_MS - 1, text: "# 规格\n模板：code\n\n## 目标\n" }), now);
  return isStop(r) ? `${r.gate}:${r.why}` : "open";
}
const claim = (key: string): string => { const g = ledgerGate(db, getFeature(db, FID)!, key, svc); return g ? `${g.gate}:${g.why}` : "open"; };

beforeEach(async () => {
  now = 10_000_000;
  dir = mkdtempSync(join(tmpdir(), "secpool2-cap-"));
  const pub = gitRepo(join(dir, "claudestra"), `https://github.com/${PUB}.git`), priv = gitRepo(join(dir, "cloud"), `git@github.com:${PRIV}.git`);
  projectsBefore = existsSync(PROJECTS_PATH) ? readFileSync(PROJECTS_PATH, "utf8") : null;
  writeFileSync(PROJECTS_PATH, JSON.stringify({ projects: [{ id: P, name: P, dirs: [pub, priv], createdAt: "2026-10-10" }] }));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: ["agent-pm"] });
  await mode("off");
});
afterEach(async () => {
  await mode("off");
  if (projectsBefore === null) rmSync(PROJECTS_PATH, { force: true }); else writeFileSync(PROJECTS_PATH, projectsBefore);
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("容量估算按节点仓库（审查 private-capacity，验收线 2）", () => {
  test("autostartCapacity / 放置重核：不给仓库 = 公共仓；给私仓按私仓授权算 peer", () => {
    hello([PRIV], ["write"]);
    const pool = { remote, borrow };
    expect(autostartCapacity(db, P, 0, pool, now)).toBeTruthy();
    expect(autostartCapacity(db, P, 0, pool, now, PRIV)).toBeNull();
    expect(autostartPlacementGate(db, P, 0, { name: "mate", repo: PRIV }, pool, now)).toBeNull();
    // 非统一池：本机不写，只看 peer
    const legacy = { remote: { ...remote, agents: undefined, roles: ["write" as const], localPriority: "off" as const },
      borrow: [{ ...borrow[0], maxOpen: 2, roles: ["write" as const] }] };
    expect(autostartCapacity(db, P, 1, legacy, now)).toBeTruthy();
    expect(autostartCapacity(db, P, 1, legacy, now, PRIV)).toBeNull();
  });

  test("on：本机满、peer 只授权私仓 → 私仓节点过 feature 门与 claim 重核，公共仓节点按容量停", async () => {
    hello([PRIV]);
    await mode("on");
    plan([{ key: "a", fileGlobs: [`repo:${PRIV}/src/a.ts`] }, { key: "b", fileGlobs: ["src/lib/b.ts"] }]);
    expect(pick("a")).toBe("open");
    expect(claim("a")).toBe("open");
    const pubWhy = autostartCapacity(db, P, 0, { remote, borrow }, now);
    expect(pick("b")).toBe(`capacity:${pubWhy}`);
    expect(claim("b")).toBe(`capacity:${pubWhy}`);
  });

  test("off / observe：只按公共仓估，feature 门文案和改动前一样", async () => {
    hello([PRIV]);
    plan([{ key: "a", fileGlobs: [`repo:${PRIV}/src/a.ts`] }]);
    const pubWhy = autostartCapacity(db, P, 0, { remote, borrow }, now);
    for (const m of ["off", "observe"] as const) {
      await mode(m);
      expect(pick("a")).toBe(`capacity:${pubWhy}`);
    }
  });

  test("on：私仓没有授权的 peer 空位 → 仍按容量停，不落到公共仓空位", async () => {
    hello([PUB]);
    await mode("on");
    remote.agents = { claude: 0, codex: 0 };
    plan([{ key: "a", fileGlobs: [`repo:${PRIV}/src/a.ts`] }, { key: "b", fileGlobs: ["src/lib/b.ts"] }]);
    expect(pick("b")).toBe("open");
    expect(pick("a")).toMatch(/^capacity:/);
    expect(claim("a")).toMatch(/^capacity:/);
  });
});

describe("损坏告警带项目名（审查 corrupt-warning，验收线 8）", () => {
  test("损坏按 off；每个项目只警告一次，告警里有项目名", () => {
    const bad = join(dir, "private-pool.json"), err = spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(bad, "{oops");
      expect(privatePoolMode("project-corrupt", bad)).toBe("off");
      expect(privatePoolMode("project-corrupt", bad)).toBe("off");
      expect(privatePoolMode("project-other", bad)).toBe("off");
      const warns = err.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("private-pool"));
      expect(warns).toHaveLength(2);
      expect(warns[0]).toContain("project-corrupt");
      expect(warns[1]).toContain("project-other");
    } finally { err.mockRestore(); }
  });
});
