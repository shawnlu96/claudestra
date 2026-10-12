/**
 * dispatch-recovery-PUBFENCE1：生产的推送 / PR 端口（lend-publish-guard.ts publishPorts，lend-deps.ts 就接它）只认 publishGuard 造的守卫——
 * 不带守卫、或手写一个永远放行的函数，都一条命令不跑；带了真守卫才推。git / gh 是假 runner，journal 是内存库。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../src/lib/lend-clone.js";
import { workerName } from "../src/lib/lend-drive.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { advance, getOrder, localDay, recordAsked } from "../src/lib/lend-journal.js";
import { isPublishGuard, publishGuard, publishPorts } from "../src/lib/lend-publish-guard.js";
import { FP, harness, polled, TEXT, wire } from "./lend-harness.js";

const BR = lendBranch("T93", FP)!;
const H2 = "c".repeat(40);
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup() {
  const h = harness({ entry: { roles: ["review", "write"] } });
  const now = h.d.now();
  recordAsked(h.db, { orderId: "w1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("w1"), step: "write", pr: null } }, now);
  advance(h.db, "w1", "asked", "claimed", { wire: { order: { ...wire("w1"), step: "write", pr: null }, text: TEXT, write: { branch: BR, base: "main" } },
    day: localDay(now), leaseGen: 1, leaseUntil: now + 600_000, lastBeatAt: now }, now);
  advance(h.db, "w1", "claimed", "cloned", { dir: "/lend/work/w1" }, now);
  advance(h.db, "w1", "cloned", "started", { agent: workerName("w1"), sessionId: "s-w1", startedAt: now, submit: "sent" }, now);
  advance(h.db, "w1", "started", "result_pending", { work: { head: H2, summary: "x", selfCheck: "y" } }, now);
  const root = mkdtempSync(join(tmpdir(), "lend-audit-ports-"));
  roots.push(root);
  const ran: string[] = [];
  const run: Run = async (argv) => {
    ran.push(argv[0] === "gh" ? `gh ${argv[2]}` : (["init", "fetch", "rev-parse", "merge-base", "push"].find((s) => argv.includes(s)) ?? argv.join(" ")));
    return { code: 0, stdout: argv.includes("rev-parse") ? `${H2}\n` : argv[2] === "create" ? "https://github.com/o/r/pull/7\n" : "", stderr: "", timedOut: false };
  };
  let ownedCalls = 0;
  const ports = publishPorts((fn) => (ownedCalls++, fn()), { root, env: {}, run });
  const target = { orderId: "w1", repo: "shawnlu96/claudestra", branch: BR, base: "main", cloneDir: "/lend/work/w1", orderHead: wire("w1").head, head: H2 };
  const pr = { orderId: "w1", repo: "shawnlu96/claudestra", branch: BR, base: "main", pr: null, title: "t", body: "b" };
  return { h, ran, ports, target, pr, owned: () => ownedCalls, guard: () => publishGuard(getOrder(h.db, "w1")!, h.d) };
}

test("[验收线 2] 生产端口不带守卫 / 带手写的空守卫：不推送、不开 PR，连推送目录都不建", async () => {
  const s = setup();
  const empty = async () => null;
  expect(isPublishGuard(empty)).toBe(false);
  for (const gate of [undefined, {}, { beforeEffect: empty }]) {
    expect(await s.ports.work(s.target, gate)).toMatchObject({ ok: false, retry: false, reason: expect.stringContaining("守卫") });
    expect(await s.ports.pr(s.pr, gate)).toMatchObject({ ok: false, retry: false, reason: expect.stringContaining("守卫") });
  }
  expect(s.ran).toEqual([]);
  expect(s.owned()).toBe(0);
});

test("[验收线 2] 带 publishGuard 造的守卫：照常推送、开 PR；守卫之后收回了，同一个端口就拦在 push / pr create 之前", async () => {
  const s = setup();
  const g = s.guard();
  expect(isPublishGuard(g.gate().beforeEffect)).toBe(true);
  expect(isPublishGuard(g.check)).toBe(false); // 只核不记的那个不能当端口守卫用
  expect(await s.ports.work(s.target, g.gate())).toEqual({ ok: true });
  expect(await s.ports.pr(s.pr, g.gate())).toEqual({ ok: true, pr: 7 });
  expect(s.ran).toEqual(["init", "fetch", "rev-parse", "merge-base", "push", "gh list", "gh create"]);
  s.ran.length = 0;
  s.h.lend.lend = [];
  expect(await s.ports.work(s.target, g.gate())).toMatchObject({ ok: false, denied: { kind: "revoked" } });
  expect(await s.ports.pr(s.pr, g.gate())).toMatchObject({ ok: false, denied: { kind: "revoked" } });
  expect(s.ran).not.toContain("push");
  expect(s.ran).not.toContain("gh create");
});

test("[验收线 2] lend-deps.ts 的 push 端口就是 publishPorts，没有绕过守卫直接调 pushWork / ensurePr 的接线", () => {
  const src = readFileSync(join(import.meta.dir, "../src/lib/lend-deps.ts"), "utf8");
  expect(src).toContain("push: publishPorts(owned)");
  expect(src).not.toMatch(/\b(pushWork|ensurePr)\(/);
});
