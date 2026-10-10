/** Actual manager dispatch, strict lock and sole registry writer, with only synthetic files and a fake tmux probe. */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock } from "../src/lib/file-lock.js";
import { advance, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { appendReceipt, receiptOf } from "../src/lib/lend-receipts.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { workerArchiveIdentity } from "../src/lib/lend-worker-registry-archive.js";
import { encodeLease, SCHEDULER_LEASE_ENV } from "../src/lib/scheduler-lease-env.js";
import { archiveEndedWorker } from "../src/lib/lend-session-archive.js";
import { withWorkerArchiveLock } from "../src/manager/lend-worker-archive-cmds.js";
import { isWriteInvocation, needsWriteLock } from "../src/manager/write-commands.js";
import { readSessionHistory } from "../src/lib/session-history.js";
import { bindHash } from "../src/lib/ask-bind.js";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { openAskFull, answerAsk } from "../src/lib/ledger-asks.js";
import { testChildEnv } from "./test-env.js";

const root = mkdtempSync(join(tmpdir(), "lend-registry-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function fixture() {
  const dir = mkdtempSync(join(root, "case-"));
  const state = join(dir, "state"), home = join(dir, "home"), bin = join(dir, "bin");
  for (const path of [state, home, bin, join(dir, "runtime")]) mkdirSync(path);
  writeFileSync(join(bin, "tmux"), '#!/bin/sh\ncase "$*" in *list-windows*) exit 0;; *) exit 1;; esac\n');
  chmodSync(join(bin, "tmux"), 0o700);
  const journal = openLendJournal(join(state, "lend", "journal.sqlite"));
  const orderId = "cli-order";
  recordAsked(journal, { orderId, peer: "A", fp: "fp", family: "claude", preview: {} });
  advance(journal, orderId, "asked", "claimed", { leaseGen: 2, agent: workerName(orderId), dir: "/synthetic-clone" });
  advance(journal, orderId, "claimed", "cloned");
  advance(journal, orderId, "cloned", "started", { sessionId: "session-cli" });
  const row = advance(journal, orderId, "started", "cancelled", { settle: { notify: null, removeDir: false } });
  const id = workerArchiveIdentity(row)!;
  appendReceipt(receiptOf(row, "未知"), join(state, "lend", "receipts.jsonl"));
  journal.close();
  const info = { project: "lend", purpose: "test", created: "now", channelId: "local:test", notes: "", cwd: row.dir,
    sessionId: row.sessionId, status: "stopped", kind: "worker" };
  const registry = { socket: "fixture", agents: { [id.agent]: info, ordinary: { ...info, kind: "main", status: "active", channelId: "local:executor" } } };
  const registryPath = join(state, "registry.json");
  writeFileSync(registryPath, JSON.stringify(registry));
  const history = join(state, "archive", id.agent, `${id.sessionId}.jsonl`);
  mkdirSync(join(state, "archive", id.agent), { recursive: true });
  writeFileSync(history, JSON.stringify({ type: "assistant", sessionId: id.sessionId, message: { content: [{ type: "text", text: "retained result" }] } }) + "\n");
  const singleton = join(dir, "scheduler.pid"), maintenance = join(dir, "maint.lock");
  const a = (await acquireLock(singleton, 0))!, b = (await acquireLock(maintenance, 0))!;
  const env = testChildEnv({ HOME: home, PATH: `${bin}:${process.env.PATH}`, CLAUDESTRA_STATE_DIR: state,
    CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime"),
    [SCHEDULER_LEASE_ENV]: encodeLease({ singleton: { path: singleton, token: a.token }, maintenance: { path: maintenance, token: b.token } }),
  });
  const invoke = async (args: string[], override: Record<string, string | undefined> = {}) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "src/manager.ts", ...args], { env: { ...env, ...override }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = out.trim() ? JSON.parse(out) : { ok: false, error: err, code };
    return result as Record<string, unknown>;
  };
  return { id, row, invoke, state, registryPath, registry, history, a, b };
}

test("actual archiveEndedWorker → workflow leaf → saveRegistry preserves readable history and unrelated agents", async () => {
  const f = await fixture();
  try {
    await archiveEndedWorker(f.row, () => {}, undefined, (...args) => f.invoke(args));
    const after = JSON.parse(readFileSync(f.registryPath, "utf8"));
    expect(after.agents[f.id.agent]).toBeUndefined();
    expect(after.agents.ordinary).toEqual(f.registry.agents.ordinary);
    expect(JSON.stringify(await readSessionHistory(f.history))).toContain("retained result");
    await archiveEndedWorker(f.row, () => {}, undefined, (...args) => f.invoke(args));
    expect(JSON.parse(readFileSync(f.registryPath, "utf8"))).toEqual(after);
  } finally { f.a.release(); f.b.release(); }
});

test("metadata preview is read only; missing lease, wrong session and unauthorized historical apply retain registry", async () => {
  const f = await fixture();
  const args = ["archive-workflows", "--lend-worker"];
  try {
    const before = readFileSync(f.registryPath, "utf8");
    const preview = await f.invoke([...args, JSON.stringify(f.id)], { [SCHEDULER_LEASE_ENV]: undefined });
    expect(preview.ok).toBe(true);
    expect(preview.dryRun).toBe(true);
    expect(preview.bind).toBeDefined();
    expect(existsSync(join(f.state, "backups"))).toBe(false);
    for (const result of [
      await f.invoke([...args, "settle", JSON.stringify(f.id)], { [SCHEDULER_LEASE_ENV]: undefined }),
      await f.invoke([...args, "settle", JSON.stringify({ ...f.id, sessionId: "replacement" })]),
      await f.invoke([...args, "settle", JSON.stringify(f.id)], { CLAUDESTRA_LEND_WORKER: "1" }),
      await f.invoke([...args, "settle", JSON.stringify(f.id)], { DISCORD_CHANNEL_ID: "local:executor" }),
      await f.invoke([...args, "apply", JSON.stringify(f.id), "--ask", "not-approved"]),
    ]) expect(result.ok).toBe(false);
    expect(readFileSync(f.registryPath, "utf8")).toBe(before);
    f.a.release();
    expect((await f.invoke([...args, "settle", JSON.stringify(f.id)])).ok).toBe(false);
    expect(readFileSync(f.registryPath, "utf8")).toBe(before);
  } finally { f.a.release(); f.b.release(); }
});

test("strict lock timeout never runs effects; losing the held lock refuses publication", async () => {
  const path = join(root, "strict.lock");
  const competing = (await acquireLock(path, 0))!;
  let effects = 0;
  await expect(withWorkerArchiveLock(async () => { effects++; }, path, 0)).rejects.toThrow("超时");
  expect(effects).toBe(0);
  competing.release();
  await expect(withWorkerArchiveLock(async (check) => {
    writeFileSync(join(path, "owner"), "new-owner");
    check(); effects++;
  }, path, 0)).rejects.toThrow("已失");
  expect(effects).toBe(0);
});

test("only the explicit leaf uses a strict local lock; original workflow invocation classification is unchanged", () => {
  expect(isWriteInvocation("archive-workflows", [])).toBe(false);
  expect(needsWriteLock("archive-workflows", [])).toBe(false);
  for (const op of ["settle", "apply"]) {
    expect(isWriteInvocation("archive-workflows", ["--lend-worker", op])).toBe(true);
    expect(needsWriteLock("archive-workflows", ["--lend-worker", op])).toBe(false);
  }
  expect(isWriteInvocation("archive-workflows", ["--lend-worker", "dry-run"])).toBe(false);
  expect(needsWriteLock("create", [])).toBe(true);
});


test("historical apply requires the exact local owner ask and produces a complete backup", async () => {
  const f = await fixture();
  const ledgerPath = join(f.state, "ledger.sqlite");
  try {
    const journal = openLendJournal(join(f.state, "lend", "journal.sqlite"));
    journal.query("UPDATE lend_orders SET settle = NULL WHERE orderId = ?").run(f.id.orderId);
    journal.close();
    const args = ["archive-workflows", "--lend-worker"];
    const actorEnv = { DISCORD_CHANNEL_ID: "local:executor", [SCHEDULER_LEASE_ENV]: undefined };
    const preview = await f.invoke([...args, "dry-run", JSON.stringify(f.id)], actorEnv);
    const bind = preview.bind as { action: string; params: unknown };
    const ledger = openLedger(ledgerPath);
    const ask = openAskFull(ledger, { project: "lend", source: "reply", kind: "authorize", title: "精确清单归档", fromAgent: "ordinary",
      options: [{ type: "buttons", buttons: [{ id: "approve", label: "批准" }] }], chatId: "api:fixture",
      bind: { ...bind, approve: ["approve"], paramsHash: bindHash(bind, "ordinary") }, expiresAt: Date.now() + 60_000,
    }).ask;
    const run = () => f.invoke([...args, "apply", JSON.stringify(f.id), "--ask", ask.id], actorEnv);
    expect((await run()).ok).toBe(false);
    expect(JSON.parse(readFileSync(f.registryPath, "utf8"))).toEqual(f.registry);
    answerAsk(ledger, ask.id, { choices: ["[button:approve]"], labels: ["批准"], text: "", principal: "owner", via: "web_card", at: Date.now(), owner: true });
    expect(await run()).toMatchObject({ ok: true, archived: true });
    expect(await run()).toMatchObject({ ok: true, archived: true });
    expect(JSON.parse(readFileSync(f.registryPath, "utf8")).agents[f.id.agent]).toBeUndefined();
    expect(existsSync(join(f.state, "backups", "lend-worker-registry"))).toBe(true);
    expect(JSON.stringify(await readSessionHistory(f.history))).toContain("retained result");
  } finally { closeLedger(ledgerPath); f.a.release(); f.b.release(); }
});
