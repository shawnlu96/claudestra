/**
 * UICAR2: the canonical update-branch carry proof (review-main-carry-proof.ts `prove`, chain mode), re-run synchronously by the
 * ledger writer inside the carry's transaction, in the same temp repo where scheduler-ui-carry.ts reads main's touched list. Same
 * checks, same order: every hop a two-parent merge of the previous head and a main first-parent commit, ≤16 hops, main positions
 * never moving backwards, each hop's merge-base with main its own main parent, then byte-equal net diffs whose sha256 is the
 * receipt's. Main is the receipt's mainHead. Any doubt throws (the caller carries nothing).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { WHOLE_DIFF_ARGS } from "./git-diff-args.js";
import type { CarryEvidence } from "./scheduler-merge.js";

const SHA = /^[a-f0-9]{40}$/;
const MAX_HOPS = 16; // review-main-carry-proof.ts MAX_HOPS
export type GitRead = (...args: string[]) => Buffer;

/** Local objects only (no replace objects / lazy fetch / inherited git overrides); a non-zero exit, a warning or a cut read throws. */
export function gitIn(cwd: string): GitRead {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  return (...args) => {
    const r = spawnSync("git", args, { cwd, env, timeout: 30_000, maxBuffer: 900 << 10, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error || r.status !== 0 || r.stderr.length) throw new Error(`git ${args[0]} 失败或警告`);
    return r.stdout;
  };
}
const lines = (b: Buffer): string[] => b.toString().trim().split(/\s+/);

export function proveCarry(read: GitRead, ev: CarryEvidence): void {
  const { oldHead: old, newHead, mainParent, mainHead: main } = ev;
  if (![old, newHead, mainParent, main].every((h) => SHA.test(h))) throw new Error("head 不是完整 SHA");
  if (old === newHead) throw new Error("没有合并链");
  const path = lines(read("rev-list", "--first-parent", main));
  if (path[0] !== main || path.some((h) => !SHA.test(h)) || new Set(path).size !== path.length) throw new Error("main 父链无效");
  const pos = new Map(path.map((h, i) => [h, i]));
  const chain: { head: string; mainParent: string }[] = [], seen = new Set<string>();
  for (let cursor = newHead; cursor !== old;) {
    if (seen.has(cursor) || chain.length >= MAX_HOPS) throw new Error("父链循环或超过有限链长");
    seen.add(cursor);
    const [self, ...parents] = lines(read("rev-list", "--parents", "-n", "1", cursor));
    if (self !== cursor || parents.some((p) => !SHA.test(p))) throw new Error("head 父链读不到");
    if (parents.length !== 2 || parents[0] === parents[1]) throw new Error("新 head 不是双亲普通 merge");
    const onMain = parents.map((p) => pos.has(p));
    let previous: string, mp: string;
    if (parents.includes(old)) {
      previous = old; mp = parents.find((p) => p !== old)!;
      if (!pos.has(mp)) throw new Error("另一个父提交不在 main 上");
    } else {
      if (onMain[0] === onMain[1]) throw new Error("父链无法唯一确定 main 父提交");
      mp = parents[onMain[0] ? 0 : 1]!; previous = parents[onMain[0] ? 1 : 0]!;
    }
    chain.push({ head: cursor, mainParent: mp });
    cursor = previous;
  }
  if (chain[0]!.mainParent !== mainParent) throw new Error("main 父提交和回执对不上");
  const oldBases = lines(read("merge-base", "--all", main, old));
  if (oldBases.length !== 1 || !SHA.test(oldBases[0]!)) throw new Error("main 父链倒退或 merge-base 不唯一/不匹配");
  let previous = Infinity;
  for (const hop of [...chain].reverse()) {
    const at = pos.get(hop.mainParent)!, bases = lines(read("merge-base", "--all", main, hop.head));
    if (at > previous || bases.length !== 1 || bases[0] !== hop.mainParent) throw new Error("main 父链倒退或 merge-base 不唯一/不匹配");
    previous = at;
  }
  const net = (head: string) => read("-c", "core.quotePath=true", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary",
    "--full-index", ...WHOLE_DIFF_ARGS, "--submodule=short", `${main}...${head}`);
  const after = net(newHead);
  if (!net(old).equals(after) || createHash("sha256").update(after).digest("hex") !== ev.diffHash) throw new Error("canonical 净 diff 在本库对不上");
}
