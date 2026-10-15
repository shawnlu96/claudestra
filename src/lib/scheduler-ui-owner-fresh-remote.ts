/**
 * UIOWNCARRY2 · the remote's current main for the owner-fresh fact, read off every ledger write path (round 2: no network under the
 * write lock). Snapshots are taken inside BEGIN IMMEDIATE transactions (openSchedulerUiAsk, the plan write) in short-lived CLI
 * processes, so the fact only reads a small state-dir file per repoDir; the network part (git ls-remote, fetching a missing main / PR
 * head) runs in a detached child process started by `kickRemoteMain`, which writes that file when done. Missing / stale file = unknown
 * (the ask goes out as before) plus one kick; nothing waits on the child. tests/scheduler-ui-owner-fresh.test.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./state-dir.js";

const MAIN_REF = "refs/remotes/origin/main";
const SHA = /^[a-f0-9]{40}$/;
/** A read older than this is not "current main" any more: unknown. */
export const REMOTE_SERVE_MS = 5 * 60_000;
/** A read older than this is still served but a refresh is kicked; also the least gap between two kicks for one repoDir. */
export const REMOTE_REFRESH_MS = 60_000;

const key = (repo: string) => createHash("sha256").update(repo).digest("hex").slice(0, 24);
const cacheFile = (repo: string) => join(stateDir(), "ui-owner-fresh", `${key(repo)}.json`);
const kickFile = (repo: string) => join(stateDir(), "ui-owner-fresh", `${key(repo)}.kick`);

/** The last finished remote read for `repo`: head null = the read failed (network, rate limit). Absent / unreadable = never read. */
export function readRemoteMain(repo: string): { at: number; head: string | null } | null {
  try {
    const v = JSON.parse(readFileSync(cacheFile(repo), "utf8")) as { repo?: unknown; at?: unknown; head?: unknown };
    if (v.repo !== repo || typeof v.at !== "number") return null;
    return { at: v.at, head: typeof v.head === "string" && SHA.test(v.head) ? v.head : null };
  } catch { return null; }
}

const write = (file: string, body: string) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body); renameSync(tmp, file);
};

/**
 * The detached child's work (blocking is fine there, no ledger handle): the remote's refs/heads/main, then its commit and the given
 * PR heads fetched into repoDir when missing (the merge driver's `+refs/heads/main:refs/remotes/origin/main` refspec), then the file.
 */
export function refreshRemoteMain(repo: string, heads: readonly string[] = [], now = Date.now): void {
  const git = (timeout: number, ...args: string[]) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const r = git(15_000, "ls-remote", "--quiet", "origin", "refs/heads/main");
  const sha = r.status === 0 ? r.stdout.split(/\s+/)[0]?.trim().toLowerCase() ?? "" : "";
  const head = SHA.test(sha) ? sha : null;
  if (head) {
    const has = (s: string) => git(10_000, "cat-file", "-e", `${s}^{commit}`).status === 0;
    const want = [...(has(head) ? [] : [`+refs/heads/main:${MAIN_REF}`]), ...heads.filter((h) => SHA.test(h) && !has(h))];
    if (want.length) git(60_000, "fetch", "--no-tags", "--quiet", "origin", ...want);
  }
  write(cacheFile(repo), JSON.stringify({ repo, at: now(), head }));
}

export type Spawner = (repo: string, heads: readonly string[]) => void;
const detached: Spawner = (repo, heads) => {
  const child = spawn(process.execPath, ["--no-env-file", import.meta.path, repo, ...heads],
    { cwd: dirname(import.meta.path), detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  child.unref();
};

/** Start one background refresh for `repo` unless one was started within REMOTE_REFRESH_MS; never waits, never throws. */
export function kickRemoteMain(repo: string, heads: readonly string[], now: number, spawner: Spawner = detached): void {
  try {
    const file = kickFile(repo);
    let last = Number.NaN;
    try { last = Number(readFileSync(file, "utf8")); } catch { /* never kicked */ }
    if (Math.abs(now - last) < REMOTE_REFRESH_MS) return;
    write(file, String(now));
    spawner(repo, heads);
  } catch { /* unknown stays unknown: the ask goes out as before */ }
}

if (import.meta.main) {
  const [repo, ...heads] = process.argv.slice(2);
  if (repo) { try { refreshRemoteMain(repo, heads); } catch { /* the next kick retries */ } }
}
