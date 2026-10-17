/**
 * UIINPUT1 · UI evidence bound to the project's declared render inputs. Two throwaway repositories, built with real git in a temp
 * dir: Python / pytest + GitHub Actions (main, with an unrelated web/ the fixed rules would watch instead of frontend/) and
 * Go / Makefile (default branch develop, no web/ at all). Each covers the normal, undeclared, inferred, stale-basis and error paths;
 * the call sites (own-globs and review carry) show the old judgment red and projectUiInputs on green. Identity, read and policy
 * are injected; no network, no real project, no production state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { PmUiGate } from "../src/lib/ledger-ui-approve-verdict.js";
import { createTask } from "../src/lib/ledger-write.js";
import { builtinProjectDeclaration } from "../src/lib/project-decl-builtin.js";
import { FLOKA_DECL_REMOTE, FLOKA_DECL_VERIFIED_HEAD, FLOKA_UI_INPUTS, judgeUiInputs, projectUiInputsMode, uiGlobMatch, uiInputsGate, type UiRepoIdentity } from "../src/lib/project-ui-inputs.js";
import type { RecoveryMode, RecoveryPolicy, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { ownGlobsCarryPlan } from "../src/lib/scheduler-ui-carry-own-globs.js";
import { gitIn } from "../src/lib/scheduler-ui-carry-proof.js";
import { legacyCompare, renderInputs, uiReviewCarryPlan } from "../src/lib/scheduler-ui-review-carry.js";

const DIGEST = "d".repeat(64);
let root = "";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A throwaway repository: `variant` commits file edits (null = delete, `->x` = symlink) on a fresh branch from `from`. */
function fixture(name: string, branch: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a],
    { cwd: dir }).toString().trim();
  git("init", "-q", "-b", branch);
  let n = 0;
  const commit = (files: Record<string, string | null>, from?: string) => {
    if (from) git("checkout", "-q", "-B", `v${n++}`, from);
    for (const [f, body] of Object.entries(files)) {
      const p = join(dir, f);
      rmSync(p, { force: true });
      if (body === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      if (body.startsWith("->")) symlinkSync(body.slice(2), p); else writeFileSync(p, body);
    }
    git("add", "-A"); git("commit", "-qm", `c${n++}`);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit, read: () => gitIn(dir) };
}
type Fx = ReturnType<typeof fixture>;

const prov = (verifiedHead: string, status: "verified" | "inferred" = "verified") =>
  status === "verified" ? { status, verifiedHead, verifiedAt: "2026-10-01T00:00:00Z" } : { status };
/** A version 1 declaration (project-decl-schema.ts) with the given UI inputs, basis and one author command. */
function decl(o: { remote: string; branch: string; renderInputs: string[]; basis: Record<string, string>; author: string[]; verifiedHead: string;
  status?: "verified" | "inferred" }) {
  const p = prov(o.verifiedHead, o.status);
  return JSON.stringify({ version: 1, repository: { remote: o.remote, defaultBranch: o.branch, targetBranch: o.branch },
    validation: { author: [{ id: "test", argv: o.author, cwd: ".", timeoutSec: 600, provenance: p }], review: [], build: [] },
    tests: { rules: [], globs: ["tests/**"] }, ci: { provider: "github", workflows: [], requiredChecks: ["test"], testAdapter: null, reports: [] },
    ui: { renderInputs: o.renderInputs }, verification: { probes: [] }, deploy: { adapter: "none", provenance: p },
    basis: Object.entries(o.basis).map(([path, body]) => ({ path, sha256: sha(body) })) }, null, 2);
}

const PY = { remote: "example/py-app", ci: "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pytest\n" };
const GO = { remote: "example/go-svc", make: "test:\n\tgo test ./...\n" };
let py: Fx, go: Fx;
const P: Record<string, string> = {}, G: Record<string, string> = {};
const pyId: UiRepoIdentity = { remote: PY.remote, isFloka: () => false }, goId: UiRepoIdentity = { remote: GO.remote, isFloka: () => false };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "uiinput1-"));
  py = fixture("py", "main");
  P.code = py.commit({ "pyproject.toml": "[project]\nname='app'\n", "requirements.txt": "flask==3.0\n", "app/core.py": "x = 1\n",
    "tests/test_app.py": "def test_x():\n    assert True\n", ".github/workflows/ci.yml": PY.ci, "frontend/index.html": "<p>v1</p>\n",
    "frontend/package.json": "{}\n", "packages/shared/theme.css": "a{}\n", "web/README.md": "docs site, not the UI\n" });
  const pyDecl = (o: Partial<Parameters<typeof decl>[0]> = {}) => decl({ remote: PY.remote, branch: "main", renderInputs: ["frontend/**", "packages/shared/**"],
    basis: { ".github/workflows/ci.yml": PY.ci }, author: ["pytest", "-q"], verifiedHead: P.code!, ...o });
  P.approved = py.commit({ ".floka/project.json": pyDecl() });
  P.lib = py.commit({ "app/core.py": "x = 2\n" }, P.approved);
  P.frontend = py.commit({ "frontend/index.html": "<p>v2</p>\n" }, P.approved);
  P.shared = py.commit({ "packages/shared/theme.css": "a{color:red}\n" }, P.approved);
  P.dep = py.commit({ "requirements.txt": "flask==3.1\n" }, P.approved);
  P.web = py.commit({ "web/README.md": "docs v2\n" }, P.approved);
  P.stale = py.commit({ ".github/workflows/ci.yml": `${PY.ci}      - run: ruff .\n` }, P.approved);
  P.undeclared = py.commit({ ".floka/project.json": null }, P.approved);
  P.inferred = py.commit({ ".floka/project.json": pyDecl({ status: "inferred" }) }, P.approved);
  P.empty = py.commit({ ".floka/project.json": pyDecl({ renderInputs: [] }) }, P.approved);
  P.nobasis = py.commit({ ".floka/project.json": pyDecl({ basis: {} }) }, P.approved);
  P.missing = py.commit({ ".floka/project.json": pyDecl({ renderInputs: ["frontend/**", "site/**"] }) }, P.approved);
  P.mismatch = py.commit({ ".floka/project.json": pyDecl({ remote: "example/other" }) }, P.approved);
  P.foreign = py.commit({ ".floka/project.json": pyDecl({ verifiedHead: "a".repeat(40) }) }, P.approved);
  P.corrupt = py.commit({ ".floka/project.json": "{\"version\": 1," }, P.approved);
  P.link = py.commit({ "frontend/link.html": "->index.html" }, P.approved);

  go = fixture("go", "develop");
  G.code = go.commit({ "go.mod": "module example.com/svc\n", "go.sum": "a v1 h1:x\n", Makefile: GO.make, "cmd/server/main.go": "package main\n",
    "internal/ui/templates/index.tmpl": "<p>v1</p>\n", "internal/ui/static/app.css": "a{}\n" });
  const goDecl = (o: Partial<Parameters<typeof decl>[0]> = {}) => decl({ remote: GO.remote, branch: "develop", renderInputs: ["internal/ui/**"],
    basis: { Makefile: GO.make }, author: ["make", "test"], verifiedHead: G.code!, ...o });
  G.approved = go.commit({ ".floka/project.json": goDecl() });
  G.lib = go.commit({ "cmd/server/main.go": "package main\n// v2\n" }, G.approved);
  G.template = go.commit({ "internal/ui/templates/index.tmpl": "<p>v2</p>\n" }, G.approved);
  G.dep = go.commit({ "go.sum": "a v1 h1:y\n" }, G.approved);
  G.stale = go.commit({ Makefile: `${GO.make}lint:\n\tgo vet ./...\n` }, G.approved);
  G.undeclared = go.commit({ ".floka/project.json": null }, G.approved);
  G.inferred = go.commit({ ".floka/project.json": goDecl({ status: "inferred" }) }, G.approved);
  G.noui = go.commit({ ".floka/project.json": goDecl({ renderInputs: [] }) }, G.approved);
  G.link = go.commit({ "internal/ui/static/vendor": "->../../../go.mod" }, G.approved);
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const judge = (fx: Fx, id: UiRepoIdentity, evidence: string, target: string, fileGlobs: string[] = []) =>
  judgeUiInputs(fx.read(), { project: "p", evidenceHeads: [evidence], targetHead: target, fileGlobs, identity: id });
const status = (v: ReturnType<typeof judge>) => v.ok ? (v.same ? "same" : "changed") : v.reason;

describe("uiGlobMatch: segment globs, case-insensitive, dir/** covers the dir itself", () => {
  test("table", () => {
    const rows: [string, string, boolean][] = [["web/**", "web", true], ["web/**", "Web/a/b.tsx", true], ["web/**", "webx/a", false],
      ["package.json", "package.json", true], ["package.json", "web/package.json", false], ["tsconfig*.json", "tsconfig.json", true],
      ["tsconfig*.json", "TSCONFIG.base.json", true], ["?*.config.ts", "vite.config.ts", true], ["?*.config.ts", ".config.ts", false],
      ["frontend/**", "frontend/src/a.tsx", true], ["internal/ui/**", "internal/uix/a", false], ["**/x.css", "a/b/x.css", true]];
    for (const [g, p, want] of rows) expect(`${g} ${p} ${uiGlobMatch(g, p)}`).toBe(`${g} ${p} ${want}`);
  });
});

describe("Python / pytest + GitHub Actions fixture (main)", () => {
  test("normal: a code-only change keeps the inputs; frontend/, a shared package and a root dependency file each change them", () => {
    expect(status(judge(py, pyId, P.approved!, P.lib!))).toBe("same");
    for (const k of ["frontend", "shared", "dep"]) expect(`${k}:${status(judge(py, pyId, P.approved!, P[k]!))}`).toBe(`${k}:changed`);
    const v = judge(py, pyId, P.approved!, P.lib!);
    expect(v.ok && v.summary).toMatchObject({ repo: PY.remote, source: "target", basis: "ok", trust: "verified", targetHead: P.lib, evidenceHeads: [P.approved] });
    if (v.ok) expect(v.summary.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  test("an unrelated web/ is not a UI input here: changing it keeps the inputs", () => {
    expect(status(judge(py, pyId, P.approved!, P.web!))).toBe("same");
  });
  test("undeclared, inferred, empty inputs, no basis, stale basis, foreign verification head: each a reason, never a pass", () => {
    const want: Record<string, string> = { undeclared: "UNDECLARED", inferred: "INFERRED", empty: "INPUTS_EMPTY", nobasis: "BASIS_MISSING",
      stale: "BASIS_STALE", foreign: "UNVERIFIED" };
    for (const [k, reason] of Object.entries(want)) {
      const v = judge(py, pyId, P.approved!, P[k]!);
      expect(`${k}:${status(v)}`).toBe(`${k}:${reason}`);
      if (!v.ok) expect(v.why).toContain("manager project-decl");
    }
  });
  test("error paths: declared input missing, repository mismatch / unknown, corrupt JSON, a symlink among the inputs, unreadable git", () => {
    expect(status(judge(py, pyId, P.approved!, P.missing!))).toBe("DEPENDENCY_UNKNOWN");
    expect(status(judge(py, pyId, P.approved!, P.mismatch!))).toBe("REPOSITORY_MISMATCH");
    expect(status(judge(py, { remote: null, isFloka: () => false }, P.approved!, P.lib!))).toBe("REPOSITORY_UNKNOWN");
    expect(status(judge(py, pyId, P.approved!, P.corrupt!))).toBe("INVALID_DECLARATION");
    expect(status(judge(py, pyId, P.approved!, P.link!))).toBe("DEPENDENCY_UNKNOWN");
    expect(status(judge(py, pyId, P.approved!, "f".repeat(40)))).toBe("READ_FAILED");
  });
  test("the card's fileGlobs join the inputs but never make an undeclared project complete", () => {
    expect(status(judge(py, pyId, P.approved!, P.lib!, ["app/**"]))).toBe("changed");
    expect(status(judge(py, pyId, P.approved!, P.undeclared!, ["frontend/**"]))).toBe("UNDECLARED");
  });
});

describe("Go / Makefile fixture (develop, no web/)", () => {
  test("normal: code-only same; a template and go.sum (root dependency above the UI dir) change the inputs", () => {
    expect(status(judge(go, goId, G.approved!, G.lib!))).toBe("same");
    expect(status(judge(go, goId, G.approved!, G.template!))).toBe("changed");
    expect(status(judge(go, goId, G.approved!, G.dep!))).toBe("changed");
  });
  test("undeclared / inferred / stale / no UI inputs / symlink: reasons, and none of them is about a missing web/", () => {
    const want: Record<string, string> = { undeclared: "UNDECLARED", inferred: "INFERRED", stale: "BASIS_STALE", noui: "INPUTS_EMPTY", link: "DEPENDENCY_UNKNOWN" };
    for (const [k, reason] of Object.entries(want)) {
      const v = judge(go, goId, G.approved!, G[k]!);
      expect(`${k}:${status(v)}`).toBe(`${k}:${reason}`);
      if (!v.ok) expect(v.why).not.toContain("web/");
    }
  });
  test("the fixed rules on this repo only know web/: they cannot prove anything here (the reason the old path refused)", () => {
    expect(() => renderInputs(go.read(), G.lib!, [])).toThrow(/缺 web/);
  });
});

describe("Floka: the built-in declaration digests this repository's own HEAD exactly as the fixed rules", () => {
  test("same inputs, same count, same digest", () => {
    const read = gitIn(process.cwd()), head = read("rev-parse", "HEAD").toString().trim();
    const old = renderInputs(read, head, ["src/lib/project-ui-inputs.ts"]);
    const v = judgeUiInputs(read, { project: "floka", evidenceHeads: [head], targetHead: head, fileGlobs: ["src/lib/project-ui-inputs.ts"],
      identity: { remote: "shawnlu96/claudestra", isFloka: () => true } });
    expect(v.ok && { inputs: v.summary.inputs, count: v.summary.count }).toEqual({ inputs: old.digest, count: old.count });
    expect(FLOKA_UI_INPUTS.renderInputs).toContain("src/bridge/**");
  });
  test("the Floka check is the built-in's own: same remote, same shipped verification head", () => {
    const head = gitIn(process.cwd())("rev-parse", "HEAD").toString().trim();
    const d = builtinProjectDeclaration({ root: process.cwd(), remote: FLOKA_DECL_REMOTE, targetBranch: "main", targetHead: head, tree: new Map() });
    expect(d?.repository.remote).toBe(FLOKA_DECL_REMOTE);
    expect(d?.validation.author[0]?.provenance.verifiedHead).toBe(FLOKA_DECL_VERIFIED_HEAD);
  });
});

const port = (m: Record<string, RecoveryMode>): RecoveryPolicyPort => (_p, key) => ({ mode: m[key] ?? "off", manualAfterMs: null, source: "config" } as RecoveryPolicy);
function ledger() {
  const dir = mkdtempSync(join(root, "ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  createTask(db, { actor: "owner" }, { project: "p", id: "T1", title: "ui", kind: "code", agent: "agent-author" });
  return { db, close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); },
    notes: () => listEvents(db, { project: "p" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "projectUiInputs") };
}

describe("switch projectUiInputs: off = old judgment only, observe = old acts + one note per disagreement, on = declared inputs act", () => {
  const gate = (db: ReturnType<typeof ledger>["db"], mode: RecoveryMode, target: string) => uiInputsGate({ db, project: "p", task: "T1", path: "review",
    now: 1, read: py.read, evidenceHeads: [P.approved!], targetHead: target, fileGlobs: [], deps: { identity: () => pyId }, policy: port({ projectUiInputs: mode }),
    legacy: () => legacyCompare(py.read, [P.approved!], target, []) });
  test("default class: unreadable policy is off", () => {
    expect(projectUiInputsMode("p", () => { throw new Error("x"); })).toBe("off");
  });
  test("off reads nothing new; observe returns the old outcome and notes the disagreement once; on returns the new outcome", () => {
    const l = ledger();
    try {
      expect(gate(l.db, "off", P.frontend!).outcome.status).toBe("same"); // the fixed rules watch web/, not frontend/ (red)
      const o = gate(l.db, "observe", P.frontend!);
      expect(o.outcome.status).toBe("same");
      o.observe(); o.observe();
      expect(l.notes().length).toBe(1);
      expect(l.notes()[0]!.data).toMatchObject({ path: "review", legacy: "same", candidate: "changed" });
      gate(l.db, "observe", P.lib!).observe(); // both say same: nothing to note
      expect(l.notes().length).toBe(1);
      expect(gate(l.db, "on", P.frontend!).outcome.status).toBe("changed"); // green
      expect(gate(l.db, "on", P.undeclared!).outcome).toMatchObject({ status: "error" });
    } finally { l.close(); }
  });
});

const task = (fileGlobs: string[]) => ({ id: "T1", project: "p", round: 1, specRev: 1, extra: { screenshotsDigest: DIGEST, fileGlobs } }) as unknown as LedgerTask;
const pmAt = (head: string): PmUiGate => ({ state: "approved", seq: 5, head, round: 1, specRev: 1, screenshotsDigest: DIGEST });
const ev = (oldHead: string, newHead: string) => ({ oldHead, newHead, mainParent: "1".repeat(40), mainHead: "2".repeat(40), diffHash: "3".repeat(64) });

describe("safety core at the call sites: red under the old judgment, green under projectUiInputs on", () => {
  const review = (db: ReturnType<typeof ledger>["db"], fx: Fx, id: UiRepoIdentity, from: string, to: string, mode: RecoveryMode, globs: string[] = ["tests/test_app.py"]) =>
    uiReviewCarryPlan(db, { task: task(globs), intentId: "i1", ev: ev(from, to), pm: pmAt(from), approval: { seq: 5, actor: "agent-pm", data: { op: "ui_approved" } } as unknown as LedgerEvent,
      ownerVisual: false, heldFrom: false, read: fx.read, now: 1, uiInputs: { identity: () => id } }, port({ uiReviewCarry: "on", projectUiInputs: mode }));
  test("review carry: frontend/ and a shared package refuse the old screenshot under on (the fixed rules carried them)", () => {
    const l = ledger();
    try {
      for (const k of ["frontend", "shared"]) {
        expect(`${k}:${review(l.db, py, pyId, P.approved!, P[k]!, "off").note}`).toBe(`${k}:null`); // red: carried
        expect(review(l.db, py, pyId, P.approved!, P[k]!, "on").note).toContain(`新 head ${P[k]!.slice(0, 12)}`); // green
      }
      expect(review(l.db, py, pyId, P.approved!, P.lib!, "on").note).toBeNull();
    } finally { l.close(); }
  });
  test("review carry: undeclared, inferred and stale refuse with the reason and the manual entry, asking for the new head", () => {
    const l = ledger();
    try {
      for (const [k, reason] of [["undeclared", "UNDECLARED"], ["inferred", "INFERRED"], ["stale", "BASIS_STALE"], ["empty", "INPUTS_EMPTY"]] as const) {
        expect(review(l.db, py, pyId, P.approved!, P[k]!, "off").note).toBeNull(); // red: the unrelated web/ was enough
        const note = review(l.db, py, pyId, P.approved!, P[k]!, "on").note!;
        expect(note).toContain(reason); expect(note).toContain("manager project-decl"); expect(note).toContain(`新 head ${P[k]!.slice(0, 12)}`);
      }
    } finally { l.close(); }
  });
  test("review carry: the Go fixture without web/ never carries, and on says why without blaming web/", () => {
    const l = ledger();
    try {
      expect(review(l.db, go, goId, G.approved!, G.lib!, "on").note).toBeNull();
      for (const k of ["noui", "undeclared"]) {
        expect(review(l.db, go, goId, G.approved!, G[k]!, "off").note).toContain("缺 web/");
        const note = review(l.db, go, goId, G.approved!, G[k]!, "on").note!;
        expect(note).not.toContain("web/"); expect(note).toContain("重新验收");
      }
    } finally { l.close(); }
  });
  test("own-globs carry: undeclared / stale / no-UI projects stop carrying under on; a complete declaration carries with its summary", () => {
    const l = ledger();
    try {
      const plan = (fx: Fx, id: UiRepoIdentity, from: string, to: string, mode: RecoveryMode) => {
        const writes: Record<string, unknown>[] = [];
        const p = ownGlobsCarryPlan(l.db, { task: task(["app/core.py"]), intentId: "i1", ev: ev(from, to), pm: pmAt(from), ownerVisual: false, now: 1,
          facts: { mainBase: "4".repeat(40), files: ["frontend/index.html"], netPaths: ["app/core.py"] },
          uiInputs: { identity: () => id, read: () => fx.read() }, policy: port({ projectUiInputs: mode }) }, "on", (_s, _t, d) => void writes.push(d));
        p.commit(7);
        return { carried: p.carried, data: writes[0] };
      };
      for (const k of ["undeclared", "stale", "empty"]) {
        expect(`${k}:${plan(py, pyId, P.approved!, P[k]!, "off").carried}`).toBe(`${k}:true`); // red
        expect(`${k}:${plan(py, pyId, P.approved!, P[k]!, "on").carried}`).toBe(`${k}:false`); // green
      }
      expect(plan(go, goId, G.approved!, G.noui!, "on").carried).toBe(false);
      const ok = plan(py, pyId, P.approved!, P.lib!, "on");
      expect(ok.carried).toBe(true);
      expect(ok.data).toMatchObject({ uiInputs: { source: "target", trust: "verified", targetHead: P.lib } });
      expect(plan(py, pyId, P.approved!, P.lib!, "off").data).not.toHaveProperty("uiInputs"); // off: the record as before
      const before = l.notes().length;
      expect(plan(py, pyId, P.approved!, P.undeclared!, "observe").carried).toBe(true); // observe: old action
      expect(l.notes().length).toBe(before + 1);
    } finally { l.close(); }
  });
});
