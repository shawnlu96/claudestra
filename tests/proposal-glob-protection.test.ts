import { expect, test } from "bun:test";
import { globDetails, repoFiles } from "../src/lib/center-proposal-auto-surface.js";

const SPLIT = [
  "src/lib/new-s?cret.ts", "src/lib/new-[s]ecret.ts", "src/bridge/new-au[t]h.ts", "src/lib/ledger-sch?ma-v2.ts",
  "src/lib/mi[g]rate-x.ts", "src/lib/x.sq?", "src/lib/ask-sc?pe-new.ts", "src/lib/ord?r-ask-new.ts", "src/lib/new-k?y.ts",
];

test("wild-name-2: all nine untracked split spellings are protected with empty and real file lists", () => {
  for (const files of [[], repoFiles()]) for (const g of SPLIT) expect(globDetails(g, files, "on").length).toBeGreaterThan(0);
});

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProposal } from "../src/lib/center-proposal-auto.js";
import { globSpellingProof, type GlobProtectionContext } from "../src/lib/proposal-glob-protection.js";
import { KEYWORDS } from "../src/lib/peer-pr-surface.js";
import { listEvents, openLedger } from "../src/lib/ledger-store.js";
import { openAsk, listAsks, closeAsk } from "../src/lib/ledger-asks.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { RECOVERY_POLICY_PATH, recoveryPolicy, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { createFeatureProposalFixtures } from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import type { ProposalRecord } from "../src/lib/shared-ledger-feature-proposals.js";
import { pollCenterProposals, type ProposalInboxDeps } from "../src/bridge/center-proposal-inbox.js";

const PLAIN = ["scripts/usage-cache-write.sh", "scripts/foo-*.sh", "src/lib/runtimes/opencode*.ts", "src/lib/acp/retry-*.ts",
  "src/lib/plain-*.ts", "tests/fixtures/opencode-acp/*.jsonl", "tests/fixtures/x?.json"];
const fx = createFeatureProposalFixtures();
function record(globs: string[], id = "proposal-spelling"): ProposalRecord {
  return { proposal: { ...fx.newProposal, nodes: [{ ...fx.newProposal.nodes[0]!, fileGlobs: globs }] },
    proposalId: id, proposalRev: 1, proposer: { type: "person", personId: "person-demo", instanceId: "instance-demo" },
    operation: { ...fx.operations[0]!, proposalId: id } };
}
function context(mode: RecoveryMode): GlobProtectionContext {
  const db = openLedger(tempLedgerPath("spelling-"));
  return { project: "spelling", db: () => db, now: () => fx.now,
    policy: () => ({ mode, source: "config", manualAfterMs: null }) };
}

function on(g: string, files: readonly string[] | null = []): ReturnType<typeof globDetails> { return globDetails(g, files, "on"); }

test("PM ruling: seven ordinary globs remain auto in on, observe and off", () => {
  for (const mode of ["on", "observe", "off"] as const) {
    const ctx = context(mode);
    for (const files of [[], repoFiles()]) expect(classifyProposal(record(PLAIN), files, ctx).route).toBe("auto");
    ctx.db().close();
  }
});

test("PM boundary: star alone does not invent a protected word; tracked matches and anchored fragments do", () => {
  const g = "src/lib/plain-*.ts", secret = "src/lib/plain-secret.ts";
  expect(new Bun.Glob(g).match(secret)).toBe(true);
  expect(on(secret).some(h => h.reason === "glob_security_surface")).toBe(true);
  expect(on(g)).toEqual([]);
  expect(on(g, [secret]).some(h => h.path === secret)).toBe(true);
  for (const anchored of ["src/lib/new-*cret.ts", "src/lib/*-tok?n.ts", "src/lib/aut*.ts", "src/lib/s*ecret.ts"])
    expect(on(anchored).length).toBeGreaterThan(0);
  for (const unanchored of ["src/lib/a*.ts", "src/lib/se*.ts", "src/lib/plain-**/x.ts"])
    expect(on(unanchored).map(h => h.reason)).not.toContain("glob_security_surface");
});

test("bounded spellings cover every keyword, preserve ranges, case and nested brace alternatives", () => {
  for (const word of KEYWORDS) {
    for (let i = 0; i < word.length; i++) {
      const name = word.slice(0, i) + "?" + word.slice(i + 1);
      expect(on(`src/lib/z-${name}.ts`).some(h => h.reason === "glob_security_surface")).toBe(true);
    }
  }
  for (const g of ["SRC/LIB/NEW-S?CRET.TS", "src/lib/new-{s,{S,x}}[e]cret.ts", "src/lib/new-[^x]ecret.ts",
    "src/lib/new-[A-z]ecret.ts", "src/**/new-s?cret.ts", "src/lib/x-s?cret-????.ts"])
    expect(on(g).length).toBeGreaterThan(0);
  for (const g of ["src/lib/new-[abc]ecret.ts", "src/lib/new-{a,{b,c}}ecret.ts", "src/lib/new-s[!e]cret.ts"])
    expect(on(g)).toEqual([]);
  const proof = globSpellingProof("src/lib/p[A-z]s?cret.ts");
  expect(proof.unresolved).toBeUndefined();
  expect(on("src/lib/p[A-z]s?cret.ts").length).toBeGreaterThan(0);
});

test("tests/docs exemption applies only to names; fixed protections, traversal and syntax still guard them", () => {
  for (const root of ["tests", "docs", "TESTS", "DOCS"]) for (const g of SPLIT)
    expect(on(`${root}/${g.slice(g.lastIndexOf("/") + 1)}`)).toEqual([]);
  expect(on("tests/preloa?.ts").length).toBeGreaterThan(0);
  expect(on("docs/.claud[e]/a.md").length).toBeGreaterThan(0);
  for (const g of ["tests/../src/lib/plain.ts", "/src/lib/plain.ts", "src//plain.ts", "src/./plain.ts"])
    expect(on(g).map(h => h.reason)).toContain("glob_invalid");
  for (const g of ["src/lib/a[.ts", "src/lib/a!(x).ts", "src/{lib/x,bridge}/a.ts", "src/lib/a**.ts"])
    expect(on(g).map(h => h.reason)).toContain("glob_unresolved");
  expect(on("tests/fixtures/x?.json", null).map(h => h.reason)).toContain("glob_unresolved");
});

test("name language includes bounded extensions, contextual permission prefixes and SQL word boundaries", () => {
  for (const g of ["src/lib/ord?r-ask-new.t?", "src/?ib/ledger-che?ks-new.t?", "src/**/ledger-che?ks-new.t?",
    "src/lib/x.sq?[a-z_]", "web/p?blic/new/s?.?js"])
    expect(on(g).length).toBeGreaterThan(0);
  expect(on("src/not-lib/ledger-che?ks-new.t?")).toEqual([]);
  expect(on("src/lib/x.sq?[a-z]")).toEqual([]);
});

test("over-budget alternatives, nested depth and state products are bounded owner outcomes", () => {
  for (const g of ["src/lib/" + "{a,b}".repeat(8) + ".ts", "src/lib/" + "{a,b}".repeat(7) + "[x]".repeat(100) + ".ts",
    "src/lib/" + "{".repeat(260) + "x" + "}".repeat(260)]) {
    const start = performance.now(), proof = globSpellingProof(g);
    expect(proof.unresolved).toBe("budget");
    expect(on(g).length).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(2000);
  }
});

test("observe records only new hits once, returns the exact baseline; off records nothing", () => {
  for (const mode of ["observe", "off"] as const) {
    const ctx = context(mode), r = record([SPLIT[0]!]);
    expect(classifyProposal(r, [], ctx)).toEqual(classifyProposal(r, []));
    classifyProposal(r, [], ctx);
    const samples = () => listEvents(ctx.db(), { project: ctx.project }).filter(e => e.data.mechanism === "proposalGlobProtection");
    expect(samples()).toHaveLength(mode === "observe" ? 1 : 0);
    if (mode === "observe") {
      expect(samples()[0]!.data).toMatchObject({ oldReasons: [], newReasons: ["glob_security_surface"], addedOmitted: 0 });
      const hit = (samples()[0]!.data.added as { path: string }[])[0]!;
      expect(hit.path).toBe("src/lib/new-secret.ts");
      classifyProposal(record(["src/lib/new-secret.ts"], "already"), [], ctx);
      classifyProposal(record(["src/lib/new-secret*.ts"], "already-wild"), [], ctx);
      expect(samples()).toHaveLength(1);
    }
    ctx.db().close();
  }
});

test("file-backed key defaults to observe and rereads hot on/observe/off switches, respecting project overrides", () => {
  const path = join(mkdtempSync(join(tmpdir(), "spelling-mode-")), "policy.json"), ctx = context("off");
  ctx.policy = (p, k) => recoveryPolicy(p, k, path);
  const r = record([SPLIT[0]!]), baseline = classifyProposal(r, []);
  expect(classifyProposal(r, [], ctx)).toEqual(baseline);
  for (const mode of ["on", "observe", "off", "on"] as const) {
    writeFileSync(path, JSON.stringify({ projects: { spelling: { mode: "on", keys: { proposalGlobProtection: mode } } } }));
    expect(classifyProposal(r, [], ctx).route).toBe(mode === "on" ? "owner" : baseline.route);
  }
  writeFileSync(path, JSON.stringify({ projects: { spelling: { mode: "off" } } }));
  expect(classifyProposal(r, [], ctx)).toEqual(baseline);
  ctx.db().close();
});

function polling(records: ProposalRecord[], upstream: RecoveryMode) {
  const db = openLedger(tempLedgerPath("spelling-poll-")), project = "spelling-poll", decided: string[] = [];
  const deps: ProposalInboxDeps = {
    now: () => fx.now, projects: () => [{ localProjectId: project, scope: fx.scope }],
    list: async () => ({ proposals: records, policy: fx.policies.default, selfPersonId: "person-owner" }),
    members: async () => [{ personId: "person-owner", role: "owner", status: "active" }],
    decide: async (_scope, id) => {
      decided.push(id); const r = records.find(x => x.proposalId === id)!;
      return { ...r, operation: { ...r.operation, state: "approved" } };
    },
    openAsk: input => openAsk(db, input, fx.now),
    openCards: () => listAsks(db).filter(a => a.state === "open"),
    closeAsk: id => { closeAsk(db, id, "cancelled", "", fx.now); },
    inform: async () => {}, handoff: async () => {}, log: () => {},
    auto: { mode: () => upstream, db: () => db, hasCard: key => listAsks(db).some(a => a.dedupKey === key), files: () => [] },
  };
  return { db, project, decided, deps };
}

test("polling: protection key and upstream mode combinations keep protected globs owner-only in on", async () => {
  let previous: string | undefined;
  try { previous = readFileSync(RECOVERY_POLICY_PATH, "utf8"); } catch { /* The isolated test policy normally does not exist. */ }
  try {
    for (const protection of ["on", "observe", "off"] as const) for (const upstream of ["on", "observe", "off"] as const) {
      const h = polling([...SPLIT.map((g, i) => record([g], `split-${i}`)), record(PLAIN, "ordinary")], upstream);
      writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [h.project]: { keys: { proposalGlobProtection: protection } } } }));
      await pollCenterProposals(h.deps);
      expect(h.decided).toHaveLength(upstream === "on" ? protection === "on" ? 1 : 10 : 0);
      if (protection === "on" && upstream === "on") {
        expect(h.decided).toEqual(["ordinary"]);
        expect(listAsks(h.db).filter(a => a.state === "open")).toHaveLength(SPLIT.length);
        for (const a of listAsks(h.db)) expect(a.context).toContain("需要你批的原因：");
      }
      h.db.close();
    }
  } finally { writeFileSync(RECOVERY_POLICY_PATH, previous ?? JSON.stringify({ projects: {} })); }
});
