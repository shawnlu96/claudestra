/**
 * Taking open peer PRs in as auto cards (i28-A2 §2). classifyPr is pure: an unconfigured author is skipped silently, a
 * configured author's PR the path cannot take (fork / other head owner, base not main, odd branch name) tells PM once per PR,
 * a draft / a full queue / a head still moving waits. A taken PR: head fetched into its local ref and checked, then
 * `ledger peer-pr-intake <n> --head`, which re-reads peer-prs.json and takes every fact from GitHub itself (verifiedIntake).
 */
import { LedgerError } from "./ledger-store.js";
import { BRANCH } from "./order-deliver-pr.js";
import { peerOfLogin, type PeerPrConfig, type PeerPrPeer } from "./peer-pr-config.js";
import type { OpenPr, PeerPrGithub } from "./peer-pr-github.js";
import { cardForPr, inFlightPeerCards, type IntakeInput } from "./peer-pr-ledger.js";
import { logUnlessStopped, noticeOnce, oneLine, type PeerPrCtx, type PeerPrState } from "./peer-pr-notice.js";
import { peerPrSurface } from "./peer-pr-surface.js";

type IntakeDecision = { kind: "skip" } | { kind: "wait"; why: string } | { kind: "notice"; key: string; text: string } | { kind: "intake"; peer: PeerPrPeer };

interface IntakeFacts { repoOwner: string; hasCard: boolean; inFlight: number; stable: boolean }

function classifyPr(pr: OpenPr, cfg: PeerPrConfig, f: IntakeFacts): IntakeDecision {
  if (pr.number < cfg.fromNumber || f.hasCard) return { kind: "skip" };
  const peer = peerOfLogin(cfg, pr.login);
  if (!peer) return { kind: "skip" };
  const head = `[peer PR] #${pr.number}（${pr.login}）`;
  if (pr.crossRepo || !pr.headOwner || pr.headOwner.toLowerCase() !== f.repoOwner.toLowerCase()) {
    return { kind: "notice", key: `cross:${pr.number}`, text: `${head} 是跨仓 / fork 的 PR（head 仓库 owner ${pr.headOwner ?? "未知"}），不自动收，请人工处理：${pr.url}` };
  }
  if (pr.base !== "main") {
    return { kind: "notice", key: `base:${pr.number}`, text: `${head} 的 base 是 ${oneLine(pr.base, 80)} 不是 main，先不收；base 改成 main 后自动收：${pr.url}` };
  }
  if (!BRANCH.test(pr.branch)) return { kind: "notice", key: `branch:${pr.number}`, text: `${head} 的分支名不合规，不自动收：${pr.url}` };
  if (pr.draft) return { kind: "wait", why: "draft" };
  if (f.inFlight >= cfg.maxOpen) return { kind: "wait", why: `在途 peer 卡已满 ${cfg.maxOpen} 张` };
  if (!f.stable) return { kind: "wait", why: "head 还没稳" };
  return { kind: "intake", peer };
}

/** Same head on two polls in a row, the first of them at least settleSec ago. Updates the memory as a side effect. */
export function headStable(state: PeerPrState, n: number, head: string, now: number, settleSec: number): boolean {
  const seen = state.heads.get(n);
  if (!seen || seen.head !== head) {
    state.heads.set(n, { head, since: now, seen: 1 });
    return false;
  }
  seen.seen++;
  return seen.seen >= 2 && now - seen.since >= settleSec * 1000;
}

/**
 * The intake facts as GitHub reports them for repoDir's own repository — never as a caller claims them. The caller only names
 * the number and the head it expects; anything the tick would not take (other repo, fork / other head owner, base, branch,
 * author, draft, not open, head moved) refuses with nothing written. The surface is computed here from the file list.
 */
export async function verifiedIntake(gh: PeerPrGithub, cfg: PeerPrConfig, number: number, head: string): Promise<Omit<IntakeInput, "project" | "spec"> & { body: string }> {
  const repo = await gh.repo();
  const v = await gh.view(repo, number);
  const refuse = (why: string): never => { throw new LedgerError("invalid", `GitHub 上的 PR #${number} ${why}，不收`); };
  if (v.url !== `https://github.com/${repo}/pull/${number}`) refuse(`不在本仓库 ${repo}`);
  if (v.state !== "OPEN") refuse(`状态是 ${v.state}`);
  if (v.head !== head) refuse(`head 已是 ${v.head.slice(0, 12)}（不是 ${head.slice(0, 12)}）`);
  const pr: OpenPr = { number, url: v.url, title: v.title, login: v.login, branch: v.branch, head: v.head, base: v.base, crossRepo: v.crossRepo,
    headOwner: v.headOwner, draft: v.draft };
  const d = classifyPr(pr, cfg, { repoOwner: repo.split("/")[0]!, hasCard: false, inFlight: 0, stable: true });
  if (d.kind !== "intake") refuse(d.kind === "skip" ? "作者不在 peer-prs.json 或编号小于 fromNumber" : d.kind === "wait" ? `还不能收（${d.why}）` : d.text);
  const surface = peerPrSurface(await gh.files(repo, number), cfg.extraSecurityGlobs);
  return { number, url: v.url, head, branch: v.branch, base: v.base, login: v.login, title: oneLine(v.title, 300),
    body: (await gh.body(repo, number)).slice(0, 4000), surface: surface.surface, reasons: surface.reasons };
}

async function intakeOne(c: PeerPrCtx, pr: OpenPr): Promise<string> {
  const fetched = await c.deps.github.fetchHead(pr.number, pr.head);
  if (fetched) return `取 PR head 没对上，下一轮再收：${fetched}`;
  const r = await c.deps.manager("ledger", "peer-pr-intake", "--project", c.cfg.project, "--number", String(pr.number), "--head", pr.head);
  return r.ok === true ? `收卡 ${String((r.task as { id?: string } | undefined)?.id ?? "")}（${String(r.surface)}）` : `收卡没写进台账：${String(r.error)}`;
}

/** One poll over the open PRs; returns what happened per PR worth logging. */
export async function intakeTick(c: PeerPrCtx, repo: string, open: OpenPr[]): Promise<string[]> {
  const out: string[] = [];
  const owner = repo.split("/")[0]!;
  for (const pr of [...open].sort((a, b) => a.number - b.number)) {
    const facts: IntakeFacts = { repoOwner: owner, hasCard: !!cardForPr(c.db, c.cfg.project, pr.url),
      inFlight: inFlightPeerCards(c.db, c.cfg.project).length, stable: false };
    if (classifyPr(pr, c.cfg, facts).kind === "skip") continue;
    facts.stable = headStable(c.state, pr.number, pr.head, c.deps.now(), c.cfg.headSettleSec);
    const d = classifyPr(pr, c.cfg, facts);
    try {
      if (d.kind === "notice") await noticeOnce(c, "", d.key, d.text);
      if (d.kind === "intake") out.push(`#${pr.number} ${await intakeOne(c, pr)}`);
    } catch (e) {
      logUnlessStopped(`收 PR #${pr.number} 出错（下一轮再试）`, e);
    }
  }
  return out;
}
