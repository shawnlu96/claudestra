/**
 * rename-floka-REPOALIAS1 在台账上的两处：ledger verify 的归属判断（origin / 卡 PR / extra.repo 新旧名任意组合）、
 * peer PR 收卡按 prKey 找卡（旧名卡收新名链接 = 同一张卡；另一个仓库同编号不串）。写进台账的原串一律不改写。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OFFICIAL_REPO, PROPOSED_REPO } from "../src/lib/floka-repo/migrate.js";
import type { PeerPrConfig } from "../src/lib/peer-pr-config.js";
import { cardForPr, intakeWrite, type IntakeInput } from "../src/lib/peer-pr-ledger.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { FactsDeps } from "../src/lib/ledger-verify-facts.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { ObservedAction } from "../src/lib/recovery-policy.js";
import { setRepoAliasForTest } from "../src/lib/repo-alias.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";

const OLD = OFFICIAL_REPO, NEW = PROPOSED_REPO;
const P = "claude-orchestrator", PM = "agent-claudestra";
const pr = (repo: string, n = 150) => `https://github.com/${repo}/pull/${n}`;

let db: Database;
let lines: ObservedAction[] = [];
const mode = (m: "off" | "observe" | "on") => { lines = []; setRepoAliasForTest({ mode: m, sink: (a) => lines.push(a) }); };
beforeEach(() => { db = openLedger(":memory:"); setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM] }); });
afterEach(() => { closeLedger(":memory:"); setRepoAliasForTest({ mode: null, sink: null }); });

/** 只答 verify 归属与文件清单要的几条命令；origin 由参数给，PR 文件只有一个文档（不起 daemon / 网页探针） */
function deps(origin: string): FactsDeps {
  const out = (code: number, stdout = "") => Promise.resolve({ code, stdout, stderr: code ? "unexpected" : "" });
  const run = (argv: string[]) => {
    const cmd = argv.join(" ");
    if (cmd.startsWith("gh pr view")) return out(0, JSON.stringify({ state: "MERGED", mergeCommit: { oid: "m1" }, mergedAt: "2026-10-01T00:00:00Z", headRefOid: "h1", headRefName: "task/t" }));
    if (/^gh api --paginate repos\/[^/]+\/[^/]+\/pulls\/150\/files/.test(cmd)) return out(0, "docs/a.md\n");
    if (cmd === "git -C /repo remote get-url origin") return out(0, `git@github.com:${origin}.git\n`);
    if (cmd === "git -C /repo rev-parse --path-format=absolute --git-common-dir") return out(0, "/repo/.git\n");
    if (cmd.startsWith("git -C /repo fetch") || cmd.startsWith("git -C /repo merge-base")) return out(0);
    return out(127);
  };
  return { repoRoot: "/repo", run, localWebCommit: () => null, relayStatus: async () => null, relayWebCommit: async () => null, bridgePort: () => 3847,
    fileSize: () => null, isDir: () => true, readRepoFile: () => null };
}

async function verify(id: string, origin: string): Promise<Record<string, any>> {
  const reg = { socket: "", agents: { [PM]: { status: "active", projectId: P } } } as unknown as Registry;
  return runLedger(["verify", id, "--dry-run"], { db, actor: PM, actorProject: P, projectIds: [P], loadRegistry: async () => reg, saveRegistry: async () => {},
    now: () => 5_000, factsDeps: () => deps(origin), projects: () => [{ id: P, name: P, dirs: ["/repo"], createdAt: "" }] }) as Promise<Record<string, any>>;
}

const card = (id: string, prUrl: string, repo?: string) => createTask(db, { actor: "owner" }, {
  project: P, id, title: "t", kind: "code", pm: PM, pr: prUrl, branch: "task/t", stage: "live", round: 1, ...(repo ? { extra: { repo } } : {}) });
const ownedHere = (r: Record<string, any>) => r.checklistSource === "files" && !String(r.blocking ?? "").includes("判断不了任务所属项目");

describe("[验收线 4] ledger verify 归属：origin / 卡 PR / extra.repo 新旧名任意组合", () => {
  const combos = [OLD, NEW].flatMap((origin) => [OLD, NEW].flatMap((prRepo) => [undefined, OLD, NEW].map((repo) => ({ origin, prRepo, repo }))));

  test("档位 on：每种组合都判本仓（不是 unknown），台账里的 pr / extra.repo 原串不变", async () => {
    mode("on");
    let i = 0;
    for (const c of combos) {
      const id = `T${i++}`;
      card(id, pr(c.prRepo), c.repo);
      const r = await verify(id, c.origin);
      expect([c, ownedHere(r), r.checklistSource]).toEqual([c, true, "files"]);
      expect(getTask(db, id)).toMatchObject({ pr: pr(c.prRepo), extra: c.repo ? { repo: c.repo } : {} });
    }
  });

  test("档位 on：真外仓仍不是本仓；extra.repo 声明成外仓照旧拦下", async () => {
    mode("on");
    card("F1", pr("evil/floka"));
    expect(ownedHere(await verify("F1", NEW))).toBe(false);
    card("F2", pr("floka-ai/floka-fork"));
    expect(ownedHere(await verify("F2", OLD))).toBe(false);
    card("F3", pr(OLD), "evil/floka");
    const r = await verify("F3", NEW);
    expect(ownedHere(r)).toBe(false);
    expect(r).toMatchObject({ noteTpl: expect.stringContaining("PM 声明的仓库是 {declared}"), noteParams: { prRepo: OLD, declared: "evil/floka" } });
  });

  test("off / observe：新旧名混搭和改前一样判断不了，observe 只记一行；全是旧名时三档都判本仓、不记日志", async () => {
    for (const m of ["off", "observe"] as const) {
      mode(m);
      card(`M${m}`, pr(OLD));
      const r = await verify(`M${m}`, NEW);
      expect(ownedHere(r)).toBe(false);
      expect(r.noteTpl).toContain("PR 链接和项目对不上");
      expect(lines.map((l) => l.actionKey)).toEqual(m === "observe" ? ["ledger-verify.ownership"] : []);
    }
    for (const m of ["off", "observe", "on"] as const) {
      mode(m);
      card(`S${m}`, pr(OLD), OLD);
      expect(ownedHere(await verify(`S${m}`, OLD))).toBe(true);
      expect(lines).toEqual([]);
    }
  });
});

const H1 = "a1".repeat(20);
const cfg: PeerPrConfig = { project: "p", repoDir: "/tmp/p", fromNumber: 400, pollSec: 60, headSettleSec: 60, maxOpen: 5, maxRounds: 4, fixTimeoutH: 4,
  replyTo: "agent-pm@me", extraSecurityGlobs: [], peers: [{ peer: "he", fp: "0a1b-2c3d-4e5f-6a7b", agent: "agent-x", githubLogins: ["he-dev"], authorFamily: "codex" }] };
const input = (url: string, number = 401): IntakeInput => ({ project: "p", number, url, head: H1, branch: "fix/x", base: "main", login: "he-dev", title: "t",
  surface: "security", reasons: [], spec: "/tmp/spec.md" });
let n = 0;
const ctx = () => ({ actor: "scheduler", now: 10_000 + (n += 10) });

describe("[验收线 5] peer PR 收卡按 prKey 找卡", () => {
  beforeEach(() => setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["pm"] }));

  test("档位 on：旧名 URL 的卡用新名 URL 收 → 同一张卡、duplicate、不新建；卡上 pr 与事件里仍是旧名原串", () => {
    mode("on");
    expect(intakeWrite(db, ctx(), input(pr(OLD, 401)), cfg)).toMatchObject({ duplicate: false, task: { id: "PR401" } });
    expect(cardForPr(db, "p", pr(NEW, 401))?.id).toBe("PR401");
    expect(intakeWrite(db, ctx(), input(pr(NEW, 401)), cfg)).toMatchObject({ duplicate: true, task: { id: "PR401" } });
    expect(getTask(db, "PR401")).toMatchObject({ pr: pr(OLD, 401), extra: { peerPr: { url: pr(OLD, 401) } } });
    const created = listEvents(db, { project: "p", target: "PR401" }).find((e) => e.kind === "task" && e.data.op === "new");
    expect(JSON.stringify(created?.data)).toContain(pr(OLD, 401));
    expect(JSON.stringify(listEvents(db, { project: "p", target: "PR401" }))).not.toContain(NEW);
  });

  test("档位 on：同项目另一个仓库的同编号 PR 不认成这张卡（编号回退要求仓库相同）", () => {
    mode("on");
    intakeWrite(db, ctx(), input(pr(OLD, 401)), cfg);
    expect(cardForPr(db, "p", pr("shawnlu96/claudestra-relay", 401))).toBeNull();
    expect(cardForPr(db, "p", pr("evil/floka", 401))).toBeNull();
    expect(cardForPr(db, "p", pr("floka-ai/floka-fork", 401))).toBeNull();
    expect(() => intakeWrite(db, ctx(), input(pr("evil/floka", 401)), cfg)).toThrow(/已有卡 PR401/); // PR401 这个号已占：照旧冲突，不当重复
  });

  test("off / observe：与改前相同（编号回退不限仓库、新名链接不算重复），observe 记一行", () => {
    for (const m of ["off", "observe"] as const) {
      closeLedger(":memory:");
      db = openLedger(":memory:");
      setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["pm"] });
      mode(m);
      intakeWrite(db, ctx(), input(pr(OLD, 401)), cfg);
      expect(cardForPr(db, "p", pr("evil/floka", 401))?.id).toBe("PR401");
      expect(cardForPr(db, "p", pr(NEW, 401))?.id).toBe("PR401");
      expect(() => intakeWrite(db, ctx(), input(pr(NEW, 401)), cfg)).toThrow(/已有卡 PR401/);
      expect(lines.map((l) => l.actionKey).sort()).toEqual(m === "observe" ? ["peer-pr-ledger.cardForPr", "peer-pr-ledger.intake"] : []);
    }
  });
});
