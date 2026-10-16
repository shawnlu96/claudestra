/** SWAPFIX1 9a: GATESWAP1's tree judgment, written once, answers the same awaited and synchronous. */
import { expect, test } from "bun:test";
import { fixTreeProof, fixTreeProofSync, liveSessionAt, type TreeProofTarget } from "../src/lib/fix-tree-proof.js";

const HEAD = "a".repeat(40), OTHER = "b".repeat(40);
/** A git port answering HEAD of the tree and the source's local branch from a table; every ask is logged. */
function port(tree: { code: number; out: string }, local: { code: number; out: string }) {
  const asks: string[] = [];
  const sync = (args: string[]) => { asks.push(args.join(" ")); return args.includes("HEAD") ? tree : local; };
  return { asks, sync, async: async (args: string[]) => sync(args) };
}
const t: TreeProofTarget = { dir: "/w/t1", source: "/src", branch: "feat/T1", head: HEAD };

test("the awaited and synchronous judgment read the same steps and give the same texts", async () => {
  const cases: [TreeProofTarget, { code: number; out: string }, { code: number; out: string }, string | null, RegExp | null][] = [
    [t, { code: 0, out: HEAD }, { code: 0, out: HEAD }, null, null],
    [t, { code: 0, out: HEAD }, { code: 1, out: "" }, null, null],
    [t, { code: 0, out: `${HEAD}\n` }, { code: 0, out: `${HEAD}\n` }, null, null],
    [t, { code: 0, out: HEAD }, { code: 0, out: HEAD }, "工作树有改动", /工作树有改动/],
    [t, { code: 128, out: "fatal" }, { code: 0, out: HEAD }, null, /读不了 HEAD/],
    [t, { code: 0, out: OTHER }, { code: 0, out: HEAD }, null, /在 bbbbbbbbbbbb，不是已审修复 head/],
    [t, { code: 0, out: HEAD }, { code: 0, out: OTHER }, null, /本地分支 feat\/T1 在 bbbbbbbbbbbb/],
    [{ ...t, dir: null }, { code: 0, out: OTHER }, { code: 0, out: OTHER }, "never read", /本地分支/],
    [{ ...t, dir: null, source: null }, { code: 0, out: OTHER }, { code: 0, out: OTHER }, "never read", null],
  ];
  for (const [target, tree, local, dirty, want] of cases) {
    const a = port(tree, local), s = port(tree, local);
    const got = await fixTreeProof(a.async, target, async () => dirty);
    expect(fixTreeProofSync(s.sync, target, () => dirty)).toBe(got);
    expect(s.asks).toEqual(a.asks);
    if (want) expect(got).toMatch(want); else expect(got).toBeNull();
  }
});

test("a live session is a registry row not stopped whose cwd is the tree", () => {
  const rows = [{ name: "agent-stopped", cwd: "/w/t1", status: "stopped" }, { name: "agent-elsewhere", cwd: "/w/t2", status: "active" }];
  expect(liveSessionAt(rows, "/w/t1")).toBeNull();
  expect(liveSessionAt([...rows, { name: "agent-old", cwd: "/w/t1", status: "active" }], "/w/t1")).toBe("agent-old");
  expect(liveSessionAt([{ name: "agent-creating", cwd: "/w/t1" }], "/w/t1")).toBe("agent-creating");
});
