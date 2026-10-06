/** Git evidence only: consumers must independently locate a real PASS at oldHead (session/family/specRev/round/event).
 * This module neither manufactures a review nor authorizes carrying one. MAINP2 owns that transaction and its switch. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { runBounded } from "./run-bounded.js";

const SHA = /^[a-f0-9]{40}$/i;
const MAIN_REF = "refs/remotes/origin/main";
const DIFF_LIMIT = 900 * 1024;
const MAX_HOPS = 16;
type GitResult = { code: number; stdout: Buffer; stderr: Buffer };
type Git = (args: string[]) => Promise<GitResult>;
type Hop = Readonly<{ head: string; previousHead: string; mainParent: string }>;
type Refusal = Readonly<{ ok: false; reason: string; mainHead?: string; mainParent?: string }>;
export type MainCarryProof = Readonly<{
  ok: true; reason: string; oldHead: string; newHead: string; mainHead: string; mainParent: string;
  chain: readonly Hop[]; diffHash: string;
}>;
export interface MainCarryInput {
  repoDir: string;
  repository: string; // expected GitHub owner/repo, checked against local origin without network access
  base: string;
  mainHead: string; // full actual main observed by the caller, checked at both ends
  oldHead: string;
  newHead: string;
}
const refused = (reason: string): Refusal => Object.freeze({ ok: false, reason });

/** Unlike runBounded's decoded/chunk-capped strings, execFile returns complete raw bytes or an error.
 * Disabling replacement objects, lazy fetch and inherited git overrides keeps this a local object proof. */
function gitReader(cwd: string, command?: typeof runBounded): Git {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "" });
  const raw = (args: string[]) => new Promise<GitResult>((resolve, reject) => {
    execFile("git", args, { cwd, env, encoding: "buffer", timeout: 30_000, maxBuffer: DIFF_LIMIT }, (error, stdout, stderr) => {
      // Buffer limits and timeouts never return usable partial output; ordinary git exit 1 is needed for ancestry.
      if (error && (error.killed || typeof error.code !== "number")) { reject(error); return; }
      if (stdout.length + stderr.length >= DIFF_LIMIT) { reject(new Error("净 diff 太大或读取被截断")); return; }
      resolve({ code: error?.code as number ?? 0, stdout, stderr });
    });
  });
  return async (args) => {
    if (command) {
      const r = await command(["git", ...args], { cwd, env, timeoutMs: 30_000 });
      if (r.timedOut || r.code === null) throw new Error("git 超时或异常");
      // The scheduler wraps runBounded with its maintenance guard. Its UTF-8 chunk decoding can lose raw bytes;
      // any replacement character (including a literal one) makes this path unprovable, never equal evidence.
      if (r.stdout.includes("\uFFFD")) throw new Error("git 输出含有不可核验的 UTF-8 字节");
      if (Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) >= DIFF_LIMIT) throw new Error("净 diff 太大或读取被截断");
      const result = { code: r.code, stdout: Buffer.from(r.stdout), stderr: Buffer.from(r.stderr) };
      if (args.includes("diff")) {
        // A runner may return before pipes close, even below the cap. Require its entire diff to match a complete
        // raw read. The final guarded main observation still runs before evidence can leave this module.
        const complete = await raw(args);
        if (result.code !== complete.code || !result.stdout.equals(complete.stdout) || !result.stderr.equals(complete.stderr)) {
          throw new Error("净 diff 读取不完整或读取期间已变化");
        }
        return complete;
      }
      return result;
    }
    return raw(args);
  };
}
async function read(git: Git, ...args: string[]): Promise<Buffer> {
  const r = await git(args);
  if (r.code !== 0) throw new Error(`git ${args[0]} 失败：exit ${r.code}`);
  return r.stdout;
}
async function onMain(git: Git, parent: string, main: string): Promise<boolean> {
  const r = await git(["merge-base", "--is-ancestor", parent, main]);
  if (r.code !== 0 && r.code !== 1) throw new Error("git merge-base 失败");
  return r.code === 0;
}
async function mainAt(git: Git): Promise<string> {
  const head = (await read(git, "rev-parse", "--verify", `${MAIN_REF}^{commit}`)).toString().trim().toLowerCase();
  if (!SHA.test(head)) throw new Error("main 不是完整 SHA");
  return head;
}
async function parentsOf(git: Git, head: string): Promise<string[]> {
  const [self, ...parents] = (await read(git, "rev-list", "--parents", "-n", "1", head)).toString().trim().toLowerCase().split(/\s+/);
  if (self !== head || parents.some((p) => !SHA.test(p))) throw new Error("head 父链读不到");
  return parents;
}
/** This is the sole net-diff implementation, shared by the existing single-hop gate and the new chain proof. */
async function netDiff(git: Git, main: string, head: string): Promise<Buffer> {
  const out = await read(git, "-c", "core.quotePath=true", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
    "--binary", "--full-index", "--no-relative", "--ignore-submodules=none", `${main}...${head}`);
  if (out.length >= DIFF_LIMIT) throw new Error("净 diff 太大，无法逐字核对");
  return out;
}
async function hopOf(git: Git, head: string, old: string, main: string, single: boolean): Promise<Hop | Refusal> {
  const parents = await parentsOf(git, head);
  if (parents.length !== 2 || parents[0] === parents[1]) return refused("新 head 不是双亲普通 merge");
  let previousHead: string, mainParent: string;
  if (parents.includes(old)) {
    previousHead = old;
    mainParent = parents.find((p) => p !== old)!;
    if (!await onMain(git, mainParent, main)) return refused("另一个父提交不在 main 上");
  } else {
    if (single) return refused("新 head 不是「原审查 head + main 提交」的合并提交");
    const membership = [await onMain(git, parents[0]!, main), await onMain(git, parents[1]!, main)];
    if (membership[0] === membership[1]) return refused("父链无法唯一确定 main 父提交");
    mainParent = parents[membership[0] ? 0 : 1]!;
    previousHead = parents[membership[0] ? 1 : 0]!;
  }
  return Object.freeze({ head, previousHead, mainParent });
}
async function prove(git: Git, oldHead: string, newHead: string, single: boolean, expectedMain?: string): Promise<MainCarryProof | Refusal> {
  if (!SHA.test(oldHead) || !SHA.test(newHead)) return refused("head 不是完整 SHA");
  oldHead = oldHead.toLowerCase(); newHead = newHead.toLowerCase();
  const mainHead = await mainAt(git);
  if (expectedMain && mainHead !== expectedMain.toLowerCase()) return refused("actual main 已漂移");
  if (oldHead === newHead) return refused("没有合并链");
  const chain: Hop[] = [], seen = new Set<string>();
  let cursor = newHead;
  while (cursor !== oldHead) {
    if (seen.has(cursor) || chain.length >= (single ? 1 : MAX_HOPS)) return refused("父链循环或超过有限链长");
    seen.add(cursor);
    const hop = await hopOf(git, cursor, oldHead, mainHead, single);
    if ("ok" in hop) return hop;
    chain.push(hop);
    cursor = hop.previousHead;
  }
  const [before, after] = [await netDiff(git, mainHead, oldHead), await netDiff(git, mainHead, newHead)];
  if (await mainAt(git) !== mainHead) return refused("actual main 已漂移");
  const mainParent = chain[0]!.mainParent;
  if (!before.equals(after)) return Object.freeze({ ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent, mainHead });
  return Object.freeze({ ok: true, reason: "净 diff 一致", oldHead, newHead, mainHead, mainParent,
    chain: Object.freeze(chain.reverse()), diffHash: createHash("sha256").update(after).digest("hex") });
}
/** Read-only local proof, at most 16 merges. Errors reject the promise; callers must treat those as refusal, never PASS.
 * The deeply frozen evidence has no session, verdict or credential. Only a real stored PASS can authorize reuse. */
export async function reviewMainCarryProof(input: MainCarryInput, command?: typeof runBounded): Promise<MainCarryProof | Refusal> {
  if (input.base !== "main" || !SHA.test(input.mainHead)) return refused("base 或 actual main 无效");
  input = { ...input }; // bind the caller's heads before the first asynchronous read
  const git = gitReader(input.repoDir, command);
  const origin = (await read(git, "remote", "get-url", "origin")).toString().trim();
  const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(origin)?.[1];
  if (!repo || repo.toLowerCase() !== input.repository.toLowerCase()) return refused("repoDir 仓库与预期仓库不一致");
  return prove(git, input.oldHead, input.newHead, false, input.mainHead);
}
/** Compatibility gate: never accepts multiple hops. The adapter retains its fetch and existing PR/ledger gates. */
export async function singleMainCarryProof(cwd: string, oldHead: string, newHead: string, command?: typeof runBounded): Promise<MainCarryProof | Refusal> {
  return prove(gitReader(cwd, command), oldHead, newHead, true);
}
