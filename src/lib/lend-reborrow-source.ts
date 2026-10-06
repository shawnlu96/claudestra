/** Borrower source adapter for the official recovery CLI. No network or ledger mutation is performed implicitly. */
import type { ReborrowFacts } from "./lend-reborrow-facts.js";
import { LedgerError } from "./ledger-store.js";

export interface ReborrowSource {
  peer: string; fp: string; repo: string; branch: string; remoteHead: string;
  /** null is only valid when the card has no original PR and the remote probe confirmed no PR. */
  pr: { number: number; url: string; repo: string; branch: string; head: string; base: string } | null;
}

export interface ReborrowSourceProbe {
  /** Failure/unknown must throw or return null; absence never establishes a known remote head. */
  read(facts: ReborrowFacts): Promise<ReborrowSource | null>;
  isAncestor(repo: string, from: string, to: string): Promise<boolean | null>;
}

const fail = (why: string): never => { throw new LedgerError("conflict", `恢复来源未对账：${why}`); };
const sha = /^[0-9a-f]{40}$/;

function validateSource(f: ReborrowFacts, s: ReborrowSource): void {
  const { lease, previous, task } = f;
  if (s.peer !== lease.peer || s.fp !== lease.fp || s.repo !== lease.repo || s.branch !== lease.branch || !sha.test(s.remoteHead)) fail("远端身份、仓库、分支或 head 不符");
  if (s.pr) {
    const p = s.pr;
    if (!Number.isSafeInteger(p.number) || p.number < 1 || p.repo !== s.repo || p.branch !== s.branch || p.head !== s.remoteHead || p.base !== "main" ||
      p.url !== `https://github.com/${p.repo}/pull/${p.number}`) fail("PR 身份、head 或 main base 不符");
    if ((task.pr && task.pr !== p.url) || (previous.pr !== null && previous.pr !== p.number)) fail("原 PR 关系发生变化");
  } else if (task.pr || previous.pr !== null) fail("原 PR 失读");
}

/**
 * Borrower verifies reviewed/start ancestry only. Provider journal/checkpoint verification is mandatory at formal claim.
 * A cancelled borrower order makes no claim about the provider worker or its unsubmitted work.
 */
export async function prepareReborrowSource(facts: ReborrowFacts, probe: ReborrowSourceProbe): Promise<ReborrowSource> {
  const first = await probe.read(facts);
  if (!first) return fail("来源失读");
  validateSource(facts, first);
  const encoded = JSON.stringify(first);
  const heads = new Set([facts.previous.head, facts.task.headSHA].filter((h): h is string => h !== null));
  for (const from of heads) {
    if (!sha.test(from) || (from !== first.remoteHead && await probe.isAncestor(first.repo, from, first.remoteHead) !== true)) fail("旧起点、已审 head 或检查点未包含在当前远端 head");
  }
  const fresh = await probe.read(facts);
  if (!fresh || JSON.stringify(fresh) !== encoded) return fail("核验期间来源发生漂移");
  return JSON.parse(encoded) as ReborrowSource;
}
