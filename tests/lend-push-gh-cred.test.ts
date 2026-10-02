import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePush, pushWork } from "../src/lib/lend-push.js";
import { advance, LEND_JOURNAL_PATH, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { orderWireOf } from "../src/lib/order-wire.js";
import type { Run } from "../src/lib/lend-clone.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { DEFAULT_LEND_JOURNAL_OK } from "../src/lib/test-guard.js";
import { testChildEnv } from "./test-env.js";

const BASE = "1".repeat(40), HEAD = "2".repeat(40);
const CRED = ["-c", "credential.helper=!gh auth git-credential"];
const result = (stdout = "", code: number | null = 0, stderr = ""): BoundedResult => ({ code, stdout, stderr, timedOut: false });

function fixture(lab = false) {
  const root = mkdtempSync(join(tmpdir(), "lend-gh-")), seen: string[][] = [];
  const target = { orderId: "gh-test", repo: "o/r", branch: "lend/T1-abcd", base: "main", cloneDir: "/worker", orderHead: BASE };
  const env = { PATH: process.env.PATH, HOME: root, ...(lab ? { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_LAB_ROOT: root } : {}) };
  let head = BASE, remoteHead = BASE, failure = result(), auth = result();
  const run: Run = async (argv, opts) => {
    seen.push(argv);
    expect(opts.env?.GIT_TERMINAL_PROMPT).toBe("0");
    if (argv[0] === "gh") return auth;
    if (argv.includes("rev-parse")) return result(head);
    if (argv.includes("ls-remote")) return result(`${remoteHead}\trefs/heads/${target.branch}`);
    return argv.includes("push") ? failure : result();
  };
  return { root, target, seen, opts: { root, env, run }, work: () => { head = HEAD; }, remote: (h: string) => { remoteHead = h; },
    fail: (r: BoundedResult, a = result()) => { failure = r; auth = a; }, close: () => rmSync(root, { recursive: true, force: true }) };
}

for (const lab of [false, true]) {
  test(`${lab ? "lab file" : "GitHub HTTPS"}: probe and push use the expected credential chain and explicit refspec`, async () => {
    const f = fixture(lab);
    try {
      expect(await probePush(f.target, f.opts)).toEqual({ ok: true });
      f.work();
      expect(await pushWork({ ...f.target, head: HEAD }, f.opts)).toEqual({ ok: true });
      const url = lab ? `file://${join(f.root, "git/o/r.git")}` : "https://github.com/o/r.git";
      const prefix = ["git", ...(lab ? [] : CRED)];
      expect(f.seen.filter((a) => a.includes("push"))).toEqual([
        [...prefix, "push", "--dry-run", "--porcelain", url, `${BASE}:refs/heads/${f.target.branch}`],
        [...prefix, "push", "--porcelain", url, `${HEAD}:refs/heads/${f.target.branch}`],
      ]);
      expect(f.seen.flat()).not.toContain("credential.helper=");
      for (const argv of f.seen.filter((a) => !a.includes("push"))) expect(argv[1]).not.toBe("-c");
      expect(f.seen.some((a) => a[0] === "gh")).toBe(false);
    } finally { f.close(); }
  });

  test(`${lab ? "lab file" : "GitHub HTTPS"}: bound card head query shares the push credentials and rejects competing updates`, async () => {
    const f = fixture(lab);
    expect(LEND_JOURNAL_PATH).toStartWith(process.env.CLAUDESTRA_STATE_DIR!);
    // pushWork 只读默认 journal 核绑定，只能走默认路径：本用例放行 test-guard 的闸、finally 还原（i28-TJ1）
    const okBefore = process.env[DEFAULT_LEND_JOURNAL_OK];
    process.env[DEFAULT_LEND_JOURNAL_OK] = "1";
    const db = openLendJournal();
    f.target.orderId = `lend:GH:cv:${Date.now()}`;
    f.target.branch = "feat/GH";
    const wire = { ...orderWireOf({ taskId: "GH", specRev: 1, head: BASE, round: 4, node: "fix", step: "fix", dedupKey: f.target.orderId,
      inputs: [], outputs: [], acceptance: [], writeBack: "deliver" }, { repo: "o/r", pr: 7 }),
      convergence: { kind: "fix", intentId: "gh-test", branch: f.target.branch, peer: "Peer", proto: 3, held: true } };
    try {
      recordAsked(db, { orderId: f.target.orderId, peer: "A", fp: null, family: "codex", preview: {} });
      advance(db, f.target.orderId, "asked", "claimed", { leaseUntil: Date.now() + 3600_000,
        wire: { order: wire, text: "bound order", write: { branch: f.target.branch, base: "main" } } });
      f.work();
      expect(await pushWork({ ...f.target, head: HEAD }, f.opts)).toEqual({ ok: true });
      const url = lab ? `file://${join(f.root, "git/o/r.git")}` : "https://github.com/o/r.git";
      expect(f.seen.find((a) => a.includes("ls-remote"))).toEqual([
        "git", ...(lab ? [] : CRED), "ls-remote", url, `refs/heads/${f.target.branch}`,
      ]);
      f.remote("3".repeat(40));
      const pushesBefore = f.seen.filter((a) => a.includes("push")).length;
      expect(await pushWork({ ...f.target, head: HEAD }, f.opts)).toMatchObject({ ok: false, retry: false });
      expect(f.seen.filter((a) => a.includes("push"))).toHaveLength(pushesBefore);
    } finally {
      db.run("DELETE FROM lend_orders WHERE orderId = ?", [f.target.orderId]);
      db.close(); f.close();
      if (okBefore === undefined) delete process.env[DEFAULT_LEND_JOURNAL_OK];
      else process.env[DEFAULT_LEND_JOURNAL_OK] = okBefore;
    }
  });
}

for (const auth of [result("", 1, "not logged in"), result("", null, "spawn gh ENOENT")]) {
  test(`denied push keeps its classification and diagnoses gh: ${auth.stderr}`, async () => {
    const f = fixture();
    try {
      f.fail(result("", 128, "fatal: could not read Username: terminal prompts disabled"), auth);
      expect(await probePush(f.target, f.opts)).toMatchObject({ ok: false, retry: false, reason: expect.stringContaining("gh 未登录") });
      expect(f.seen.at(-1)).toEqual(["gh", "auth", "status", "--hostname", "github.com"]);
    } finally { f.close(); }
  });
}

test("logged-in permission failures, non-fast-forward and network failures keep their existing classification", async () => {
  const f = fixture();
  try {
    for (const [stderr, retry, reason] of [
      ["permission denied 403", false, "没有推送权限"],
      ["non-fast-forward [rejected]", false, "不强推"],
      ["network disconnected", true, "试推失败"],
    ] as const) {
      f.fail(result("", 128, stderr));
      const r = await probePush(f.target, f.opts);
      if (!r.ok) expect(r.reason.includes("gh 未登录")).toBe(false);
      expect(r).toMatchObject({ ok: false, retry, reason: expect.stringContaining(reason) });
    }
  } finally { f.close(); }
});

test("real git retains an existing helper first and falls back to gh only for incomplete credentials", async () => {
  const f = fixture(), bin = join(f.root, "bin"), log = join(f.root, "helper.log");
  try {
    expect(await probePush(f.target, f.opts)).toEqual({ ok: true });
    const push = f.seen.find((a) => a.includes("push"))!;
    const prefix = push.slice(0, push.indexOf("push"));
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "$*" >> "$HOME/helper.log"\nprintf "username=gh-test\\npassword=fake-gh\\n"\n', { mode: 0o700 });
    for (const complete of [false, true]) {
      writeFileSync(join(f.root, ".gitconfig"), `[credential]\n\thelper = "!printf 'username=user-test\\n${complete ? "password=fake-user\\n" : ""}'"\n`);
      writeFileSync(log, "");
      const r = Bun.spawnSync([...prefix, "credential", "fill"], {
        cwd: f.root, env: testChildEnv({ HOME: f.root, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }),
        stdin: Buffer.from("protocol=https\nhost=github.com\n\n"), stdout: "pipe", stderr: "pipe",
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain(`password=${complete ? "fake-user" : "fake-gh"}`);
      expect(readFileSync(log, "utf8").trim()).toBe(complete ? "" : "auth git-credential get");
    }
  } finally { f.close(); }
});
