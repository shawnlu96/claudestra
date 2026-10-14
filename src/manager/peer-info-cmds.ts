/**
 * `manager peer-info [<peer>] [--has <sha>]`（PEERINFO1）：各 peer 的 version、commit 前 12 位、更新通道、协作开关档位、取到时间。
 * 只读 bridge 落盘的 peer-presence.json（lib/peer-presence.ts），不发网络请求。
 * --has：用本机仓库判断对方 commit 是否包含这个提交（git merge-base --is-ancestor）；本机没有对方 commit 时如实说「先 fetch」，不自己 fetch。
 * tests/peer-instance-info-cmd.test.ts。
 */
import { readFileSync } from "node:fs";
import { outputSync } from "./core.js";
import { parseInstanceInfo, type PeerInstanceInfo } from "../lib/peer-instance-info.js";
import { PEER_PRESENCE_PATH } from "../lib/peer-presence.js";
import { REPO_ROOT } from "../lib/repo-root.js";

export const NO_PEER_COMMIT_LOCAL = "本机没有对方提交，先 fetch";
const USAGE = "用法：peer-info [<peer>] [--has <sha>]";
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export interface PeerInfoArgs { peer: string | null; has: string | null }

export function parsePeerInfoArgs(args: string[]): PeerInfoArgs | { error: string } {
  const out: PeerInfoArgs = { peer: null, has: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--has") {
      const v = args[++i];
      if (!v || !SHA_RE.test(v)) return { error: `--has 要一个提交号（7–40 位十六进制）。${USAGE}` };
      out.has = v.toLowerCase();
    } else if (!a.startsWith("--") && !out.peer) out.peer = a;
    else return { error: `未知参数：${a}。${USAGE}` };
  }
  return out;
}

/** 本机 git（只跑本地命令，返回退出码）；单测注入 */
export type LocalGit = (args: string[]) => number;
const localGit: LocalGit = (args) =>
  Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stdout: "ignore", stderr: "ignore", timeout: 10_000 }).exitCode ?? -1;

const hasCommit = (git: LocalGit, sha: string) => git(["cat-file", "-e", `${sha}^{commit}`]) === 0;

/** 对方 commit 是否包含 sha：只用本机已有的对象判断 */
export function containsVerdict(git: LocalGit, theirs: string | null, sha: string): string {
  if (!theirs) return "对方没报 commit";
  if (!hasCommit(git, theirs)) return NO_PEER_COMMIT_LOCAL;
  if (!hasCommit(git, sha)) return `本机没有提交 ${sha.slice(0, 12)}，先 fetch`;
  const code = git(["merge-base", "--is-ancestor", sha, theirs]);
  return code === 0 ? "包含" : code === 1 ? "不包含" : `判断失败（git 退出码 ${code}）`;
}

function infoLine(i: PeerInstanceInfo, at: string | undefined): string {
  const sw = Object.entries(i.switches).map(([k, v]) => `${k}=${v}`).join(", ") || "—";
  return `version ${i.version ?? "—"} · commit ${i.commit?.slice(0, 12) ?? "—"} · channel ${i.channel ?? "—"} · switches ${sw} · 取到 ${at ?? "—"}`;
}

export function peerInfoReport(file: unknown, a: PeerInfoArgs, git: LocalGit = localGit): string {
  const peers = (file as { peers?: unknown } | null)?.peers;
  const entries = peers && typeof peers === "object" ? Object.entries(peers as Record<string, { instance?: unknown; instanceAt?: string }>) : [];
  const picked = a.peer ? entries.filter(([n]) => n === a.peer) : entries;
  if (!picked.length) return a.peer ? `peer-presence.json 里没有 peer ${a.peer}` : "peer-presence.json 里还没有 peer（bridge 每分钟探一次）";
  return picked.map(([name, p]) => {
    const info = parseInstanceInfo(p?.instance);
    if (!info) return `${name}  对方没带 instance（没升级，或对方 peerInstanceInfo 不是 on）`;
    const line = `${name}  ${infoLine(info, p.instanceAt)}`;
    return a.has ? `${line}\n  含 ${a.has.slice(0, 12)}：${containsVerdict(git, info.commit, a.has)}` : line;
  }).join("\n");
}

export async function cmdPeerInfo(args: string[], d: { path?: string; git?: LocalGit; out?: (s: string) => void } = {}): Promise<void> {
  const out = d.out ?? ((s: string) => outputSync(s));
  const a = parsePeerInfoArgs(args);
  if ("error" in a) return out(a.error);
  let file: unknown = null;
  try { file = JSON.parse(readFileSync(d.path ?? PEER_PRESENCE_PATH, "utf8")); }
  catch { return out("读不到 peer-presence.json（bridge 没起，或还没探过）"); }
  out(peerInfoReport(file, a, d.git));
}
