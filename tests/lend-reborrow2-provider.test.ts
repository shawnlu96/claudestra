/** REBOR2 provider gate with real isolated git: journal, liveness, checkpoint bundle, cross-peer remote source, marker classes. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, FP, polled, wire, TEXT, sha } from "./lend-harness.js";
import { writeLab, writeResources } from "./lend-write-fixture.js";
import { advance, getOrder, patchOrder, recordAsked, type LendRow } from "../src/lib/lend-journal.js";
import { claimOrder, driveLeased, workerName } from "../src/lib/lend-drive.js";
import { orderDirName } from "../src/lib/lend-clone.js";
import { statePath } from "../src/lib/paths.js";
import { reborrowMarker } from "../src/lib/lend-reborrow-marker.js";
import { reborrow2Marker, type Reborrow2Binding } from "../src/lib/lend-reborrow2-marker.js";
import { recoveryClaimProblem } from "../src/lib/lend-reborrow2-provider.js";

const oldId = "lend:T93:s1:r0:a0", nextId = "lend:T93:s1:r1:a0", branch = "lend/T93-abcd", crossBranch = "lend/T93-1234";
const LAB_KEYS = ["CLAUDESTRA_SANDBOX", "CLAUDESTRA_LAB_ROOT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"];
let resources: ReturnType<typeof writeResources>, lab: ReturnType<typeof writeLab>, saved: Record<string, string | undefined>;
let pushed: string, oldDir: string;
const opened: ReturnType<typeof harness>[] = [];

beforeEach(() => {
  resources = writeResources(); lab = writeLab(resources);
  saved = Object.fromEntries(LAB_KEYS.map((k) => [k, process.env[k]]));
  for (const k of LAB_KEYS) process.env[k] = lab.env[k];
  lab.git(lab.seed, "checkout", "-q", "-B", branch);
  pushed = lab.commit(lab.seed, "pushed.txt");
  lab.git(lab.seed, "push", "-q", lab.bare, branch);
  oldDir = join(lab.root, "old-copy");
  rmSync(kept(), { recursive: true, force: true }); // the state dir outlives one test
  lab.git(lab.root, "clone", "-q", "--config", "core.symlinks=false", "-b", branch, lab.bare, oldDir); // as prepareClone: no symlinks in a lend copy
});
afterEach(async () => {
  for (const h of opened.splice(0)) h.db.close();
  for (const k of LAB_KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  await resources.dispose();
});

type Opts = { binding?: Partial<Reborrow2Binding>; acceptance?: string[]; old?: "stopped" | "acked" | "released" | "cancelled" | "none"; head?: string; nextBranch?: string };

function setup(o: Opts = {}) {
  const h = harness({ entry: { roles: ["write"], repos: ["o/r"] }, writeOpen: true }); opened.push(h);
  const b: Reborrow2Binding = { orderId: oldId, gen: 1, peer: "same", end: "stopped", src: branch, ended: 50, ...o.binding };
  const order = { ...wire(oldId), node: "write", step: "write", repo: "o/r", head: lab.main };
  const nb = o.nextBranch ?? (b.peer === "cross" ? crossBranch : branch);
  const next = { ...order, orderId: nextId, node: "fix", step: "fix", head: o.head ?? pushed, acceptance: o.acceptance ?? [reborrow2Marker(b)] };
  if (o.old !== "none") {
    recordAsked(h.db, { orderId: oldId, peer: "team-a", fp: FP, family: "codex", preview: { ...polled(oldId), step: "write" } });
    advance(h.db, oldId, "asked", "claimed", { leaseGen: 1, dir: oldDir, wire: { order, text: TEXT, write: { branch, base: "main" } } });
    const state = o.old ?? "stopped";
    if (state === "acked") {
      advance(h.db, oldId, "claimed", "cloned", {}); advance(h.db, oldId, "cloned", "started", { startedAt: 1 });
      advance(h.db, oldId, "started", "result_pending", { payload: { done: true }, payloadSha: "x" });
      advance(h.db, oldId, "result_pending", "acked", { receipt: { ok: true } });
    } else advance(h.db, oldId, "claimed", state, {});
  }
  recordAsked(h.db, { orderId: nextId, peer: "team-a", fp: FP, family: "codex", preview: { ...polled(nextId), step: "fix", repo: "o/r", head: next.head } });
  h.A.claim = () => ({ status: 200, body: { ok: true, v: 1, order: next, text: TEXT, sha256: sha(TEXT),
    write: { branch: nb, base: "main" }, lease: { gen: 1, expiresAt: 9e15, ms: 600_000 } } });
  const row = (): LendRow => {
    const r = getOrder(h.db, nextId)!;
    return r.wire ? r : { ...r, wire: { order: next, text: TEXT, write: { branch: nb, base: "main" } } };
  };
  return { h, row, check: () => recoveryClaimProblem(row(), h.d) };
}

const kept = () => statePath("lend", "reborrow2", orderDirName(nextId));
const source = () => JSON.parse(readFileSync(join(kept(), "source.json"), "utf8")) as { inRemote: string[]; unpushed: string[]; bundle: string };

test("same peer clean stop: real bundle verified, every checkpoint already in the remote start head", async () => {
  const { check } = setup();
  expect(await check()).toBeNull();
  expect(source()).toMatchObject({ unpushed: [] });
  expect(source().inRemote).toContain(pushed);
  lab.git(lab.seed, "bundle", "verify", join(kept(), source().bundle));
});

test("unpushed WIP (push timeout) is preserved separately, not merged into the start head", async () => {
  const wip = lab.commit(oldDir, "wip.txt");
  const { h, check } = setup();
  patchOrder(h.db, oldId, ["stopped"], { work: { head: wip, summary: "s", selfCheck: "c" } });
  writeFileSync(join(oldDir, "summary.txt"), "s");
  expect(await check()).toBeNull();
  expect(source().unpushed).toEqual([wip]);
  expect(lab.git(lab.root, "bundle", "list-heads", join(kept(), source().bundle))).toContain(`refs/unpushed/${wip}`);
});

test.each([
  ["dirty", "未提交修改"], ["removed-unpushed", "原副本已清理"], ["removed-no-work", "原副本已清理"],
  ["remote-moved", "订单起点"], ["alive", "仍活"], ["unknown", "仍活"], ["failure", "失败"], ["missing", "journal 失读"],
  ["payload", "未知结果"], ["settle", "settle"], ["end-mismatch", "不符"], ["fp", "实例"], ["safety", "安全拒绝"], ["symlink", "符号链接"],
])("same peer %s refuses", async (bad, why) => {
  const { h, check } = setup({ old: bad === "end-mismatch" ? "acked" : bad === "missing" ? "none" : "stopped", head: bad === "remote-moved" ? lab.main : undefined });
  if (bad === "dirty") writeFileSync(join(oldDir, "loose.txt"), "x");
  if (bad === "removed-unpushed") {
    const wip = lab.commit(oldDir, "wip.txt");
    patchOrder(h.db, oldId, ["stopped"], { work: { head: wip, summary: "s", selfCheck: "c" } });
    rmSync(oldDir, { recursive: true, force: true });
  }
  if (bad === "removed-no-work") rmSync(oldDir, { recursive: true, force: true });
  if (bad === "alive") h.registry.set(workerName(oldId), {});
  if (bad === "unknown") h.liveness.set(workerName(oldId), "unknown");
  if (bad === "failure") h.failures.set(workerName(oldId), { kind: "error", message: "boom" } as never);
  if (bad === "payload") patchOrder(h.db, oldId, ["stopped"], { payload: { pending: true } });
  if (bad === "settle") patchOrder(h.db, oldId, ["stopped"], { settle: { notify: "stopped", removeDir: false } });
  if (bad === "fp") h.db.run("UPDATE lend_orders SET fp = 'other' WHERE orderId = ?", [oldId]);
  if (bad === "safety") patchOrder(h.db, oldId, ["stopped"], { reason: "flagged for possible cybersecurity risk" });
  if (bad === "symlink") symlinkSync(join(lab.root, "synthetic-env"), join(oldDir, "planted"));
  expect(await check()).toContain(why);
});

test("a copy already removed after a never-started release is acceptable (nothing to lose)", async () => {
  const { h, check } = setup({ old: "released", binding: { end: "not_started" }, head: lab.main });
  rmSync(oldDir, { recursive: true, force: true });
  h.db.run("UPDATE lend_orders SET startedAt = NULL WHERE orderId = ?", [oldId]);
  lab.git(lab.root, "--git-dir", lab.bare, "branch", "-D", branch);
  expect(await check()).toBeNull();
});

test("a removed copy is refused even when its recorded work head is pushed: other checkpoints are not provably kept", async () => {
  const { h, check } = setup();
  lab.git(oldDir, "checkout", "-q", "-b", "private");
  const priv = lab.commit(oldDir, "private-checkpoint.txt");
  lab.git(oldDir, "update-ref", "refs/checkpoints/private", priv);
  lab.git(oldDir, "checkout", "-q", branch);
  patchOrder(h.db, oldId, ["stopped"], { work: { head: pushed, summary: "s", selfCheck: "c" } });
  rmSync(oldDir, { recursive: true, force: true });
  expect(await check()).toContain("原副本已清理");
  expect(existsSync(kept())).toBe(false);
});

test("cross peer: delivered / stopped / cancelled ends are refused even with a forged marker", async () => {
  for (const end of ["delivered", "stopped", "cancelled"] as const) {
    const bad = `[lend-reborrow2:v1 old=${oldId} gen=1 peer=cross end=${end} src=${branch} ended=50]`;
    expect(await setup({ old: "none", acceptance: [bad], head: pushed }).check()).toContain("续借拒领");
  }
});

test("cross peer: local absence of the old journal is never proof; the real remote source decides", async () => {
  lab.git(lab.root, "--git-dir", lab.bare, "branch", "-D", branch);
  const ok = setup({ old: "none", binding: { peer: "cross", end: "not_started" }, head: lab.main });
  expect(await ok.check()).toBeNull();
  const taken = setup({ old: "none", binding: { peer: "cross", end: "not_started" }, head: lab.main });
  lab.git(lab.seed, "push", "-q", lab.bare, `${pushed}:refs/heads/${crossBranch}`);
  expect(await taken.check()).toContain("新出借分支");
});

test.each([["journal-present", "本机有原单"], ["head-mismatch", "起点"], ["unreadable", "失读"]])("cross peer %s refuses", async (bad, why) => {
  const s = setup({ old: bad === "journal-present" ? "released" : "none", binding: { peer: "cross", end: "not_started" }, head: bad === "head-mismatch" ? lab.main : pushed });
  if (bad === "unreadable") rmSync(lab.bare, { recursive: true, force: true });
  expect(await s.check()).toContain(why);
});

test.each([
  ["mixed", () => [reborrow2Marker({ orderId: oldId, gen: 1, peer: "same", end: "stopped", src: branch, ended: 50 }), reborrowMarker({ orderId: oldId, gen: 1, reclaimSeq: 9 })]],
  ["duplicate", () => { const l = reborrow2Marker({ orderId: oldId, gen: 1, peer: "same", end: "stopped", src: branch, ended: 50 }); return [l, l]; }],
  ["damaged", () => ["[lend-reborrow2:v1 old=bad]"]],
])("%s reserved marker is refused, never ordinary", async (_n, acceptance) => {
  const { check } = setup({ acceptance: acceptance() });
  expect(await check()).toContain("续借拒领");
});

test("v1 markers keep the unchanged REBOR provider path", async () => {
  const { check } = setup({ acceptance: [reborrowMarker({ orderId: "lend:T93:s1:r0:a7", gen: 1, reclaimSeq: 9 })] });
  expect(await check()).toContain("续借拒领：旧 orderId/gen 的真实 journal 失读");
});

test("formal claim and the pre-start boundary both run the REBOR2 gate; a refusal never starts a worker", async () => {
  const good = setup();
  let checks = 0;
  good.h.d.reborrow2Checkpoints = async () => { checks++; };
  await claimOrder(getOrder(good.h.db, nextId)!, good.h.d);
  expect(getOrder(good.h.db, nextId)?.state).toBe("claimed");
  await driveLeased(getOrder(good.h.db, nextId)!, good.h.d);
  expect(checks).toBe(2);
  const bad = setup();
  bad.h.liveness.set(workerName(oldId), "unknown");
  await claimOrder(getOrder(bad.h.db, nextId)!, bad.h.d);
  expect(getOrder(bad.h.db, nextId)).toMatchObject({ state: "released", reason: expect.stringContaining("终态接续拒领") });
  expect(bad.h.calls.at(-1)?.body).toMatchObject({ action: "release", reason: "not_started" });
  expect(bad.h.log.created).toHaveLength(0);
  expect(existsSync(kept())).toBe(false);
});
