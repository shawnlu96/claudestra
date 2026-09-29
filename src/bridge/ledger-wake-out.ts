/**
 * 双向唤醒的两条出站（规则在 lib/ledger-wake.ts，由 bridge/team-router.ts 的游标驱动，至多一次）：
 *   sendPeerWake  以本实例身份（Bearer + 实例签名，同 http-peer.ts）给 peer 的 agent 投一条步骤单，wait 0、不等回复；
 *   postPrComment 审查结论用 gh 贴到 PR。task.pr 执行者和 peer 都能改，所以只贴本机有写权限的仓库——
 *                 否则 peer 把 pr 改成别人的仓库，就能借本机的 GitHub 身份往任意 PR 发评论。
 * 失败只返回原因给日志，不重试：唤醒丢一次，接手人照样能在卡上看到，比重发两遍刷屏好。
 */
import { signedFor } from "../lib/instance-key.js";
import type { PeerWake, PrComment } from "../lib/ledger-wake.js";
import { findHttpPeer } from "../lib/peers.js";
import { runBounded, type BoundedResult } from "../lib/run-bounded.js";
import { peerFetch } from "./relay-link.js";

const TIMEOUT_MS = 15_000;

export async function sendPeerWake(w: PeerWake): Promise<string> {
  const peer = await findHttpPeer(w.peer);
  if (!peer || peer.disabled || !peer.baseUrl || !peer.outToken) return `peer ${w.peer} 没配好（没有、停用了、或缺地址 / 出站 token），没发`;
  const url = `${peer.baseUrl.replace(/\/+$/, "")}/api/v1/agents/${encodeURIComponent(w.agent)}/messages`;
  const body = JSON.stringify({ text: w.text, wait: 0, nonce: crypto.randomUUID() });
  const headers = { Authorization: `Bearer ${peer.outToken}`, "Content-Type": "application/json", ...signedFor("POST", url, body) };
  const res = await peerFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) }, { timeoutMs: TIMEOUT_MS });
  return res.ok ? `已送达（${res.status}）` : `对方没收（${res.status}）`;
}

type Run = (argv: string[]) => Promise<BoundedResult>;
const ghRun: Run = (argv) => runBounded(argv, { env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeoutMs: 20_000 });
const why = (r: BoundedResult): string => (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code}`;

export async function postPrComment(c: PrComment, run: Run = ghRun): Promise<string> {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(c.pr);
  if (!m) return "PR 链接认不出，没贴";
  const [, repo, n] = m;
  const perm = await run(["gh", "api", `repos/${repo}`, "--jq", ".permissions.push"]);
  if (perm.code !== 0) return `查不了 ${repo} 的写权限（${why(perm)}），没贴`;
  if (perm.stdout.trim() !== "true") return `本机对 ${repo} 没有写权限，没贴`;
  const r = await run(["gh", "api", "-X", "POST", `repos/${repo}/issues/${n}/comments`, "-f", `body=${c.body}`]);
  return r.code === 0 ? `已贴到 ${repo}#${n}` : `贴 PR 失败（${why(r)}）`;
}
