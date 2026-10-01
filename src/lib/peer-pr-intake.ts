/**
 * Taking open peer PRs in as auto cards (i28-A2 §2). classifyPr is pure: an unconfigured author is skipped silently, a
 * configured author's PR the path cannot take (fork / other head owner, base not main, odd branch name) tells PM once per PR,
 * a draft / a full queue / a head still moving waits. A taken PR: file list → surface, head fetched into its local ref and
 * checked, then `ledger peer-pr-intake`, which re-reads peer-prs.json itself and owns every check again in its transaction.
 */
import { BRANCH } from "./order-deliver-pr.js";
import { peerOfLogin, type PeerPrConfig, type PeerPrPeer } from "./peer-pr-config.js";
import type { OpenPr } from "./peer-pr-github.js";
import { cardForPr, inFlightPeerCards } from "./peer-pr-ledger.js";
import { logUnlessStopped, noticeOnce, oneLine, type PeerPrCtx, type PeerPrState } from "./peer-pr-notice.js";
import { peerPrSurface } from "./peer-pr-surface.js";

export type IntakeDecision = { kind: "skip" } | { kind: "wait"; why: string } | { kind: "notice"; key: string; text: string } | { kind: "intake"; peer: PeerPrPeer };

export interface IntakeFacts { repoOwner: string; hasCard: boolean; inFlight: number; stable: boolean }

export function classifyPr(pr: OpenPr, cfg: PeerPrConfig, f: IntakeFacts): IntakeDecision {
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

async function intakeOne(c: PeerPrCtx, repo: string, pr: OpenPr): Promise<string> {
  const files = await c.deps.github.files(repo, pr.number);
  const surface = peerPrSurface(files, c.cfg.extraSecurityGlobs);
  const fetched = await c.deps.github.fetchHead(pr.number, pr.head);
  if (fetched) return `取 PR head 没对上，下一轮再收：${fetched}`;
  const body = (await c.deps.github.body(repo, pr.number)).slice(0, 4000);
  const r = await c.deps.manager("ledger", "peer-pr-intake", "--project", c.cfg.project, "--number", String(pr.number), "--url", pr.url,
    "--head", pr.head, "--branch", pr.branch, "--base", pr.base, "--login", pr.login, "--title", oneLine(pr.title, 300), "--body", body,
    "--surface", surface.surface, "--reasons", JSON.stringify(surface.reasons));
  return r.ok === true ? `收卡 ${String((r.task as { id?: string } | undefined)?.id ?? "")}（${surface.surface}）` : `收卡没写进台账：${String(r.error)}`;
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
      if (d.kind === "intake") out.push(`#${pr.number} ${await intakeOne(c, repo, pr)}`);
    } catch (e) {
      logUnlessStopped(`收 PR #${pr.number} 出错（下一轮再试）`, e);
    }
  }
  return out;
}
