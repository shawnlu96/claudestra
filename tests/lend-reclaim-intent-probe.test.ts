/** RECLAIMINT1 remote reads: only a clean, complete answer says "absent" / "none"; failures, timeouts and odd output are unknown. */
import { expect, test } from "bun:test";
import { parseBranchProbe, parsePrProbe, reclaimIntentProbe } from "../src/lib/lend-reclaim-intent-probe.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";

const B = "lend/T1-abcd", SHA = "a".repeat(40);
const res = (code: number, stdout = "", stderr = "", timedOut = false): BoundedResult => ({ code, stdout, stderr, timedOut } as BoundedResult);

test("[验收线 3] branch: exit 2 with no output is absent; one exact ref is present; failures, timeouts and odd rows are unknown", () => {
  expect(parseBranchProbe(res(2), B)).toEqual({ state: "absent" });
  expect(parseBranchProbe(res(0, `${SHA}\trefs/heads/${B}\n`), B)).toEqual({ state: "present", head: SHA });
  for (const r of [res(128, "", "fatal: Authentication failed"), res(0, "", "", true), res(2, "", "", true), res(0, ""), res(2, `${SHA}\trefs/heads/${B}`),
    res(0, `${SHA}\trefs/heads/${B}\n${SHA}\trefs/heads/${B}x`), res(0, `zz\trefs/heads/${B}`), res(0, `${SHA}\trefs/heads/other`)]) {
    expect(parseBranchProbe(r, B).state).toBe("unknown");
  }
});

test("[验收线 2、3] PRs: [] is none, rows naming the branch exist (any state), malformed or failed answers are unknown", () => {
  expect(parsePrProbe(res(0, "[]"), B)).toEqual({ state: "none" });
  expect(parsePrProbe(res(0, JSON.stringify([{ number: 41, headRefName: B }, { number: 7, headRefName: B }])), B)).toEqual({ state: "exists", numbers: [41, 7] });
  for (const r of [res(1, "", "HTTP 403"), res(0, "[]", "", true), res(0, "not json"), res(0, "{}"), res(0, JSON.stringify([{ number: "41", headRefName: B }])),
    res(0, JSON.stringify([{ number: 41, headRefName: "other" }])), res(0, JSON.stringify([null]))]) {
    expect(parsePrProbe(r, B).state).toBe("unknown");
  }
});

test("the production probe asks for every PR state and refuses bad coordinates without running anything", async () => {
  const argv: string[][] = [];
  const p = reclaimIntentProbe(async (a) => { argv.push(a); return res(0, "[]"); }, {});
  expect(await p.prs("o/r", B)).toEqual({ state: "none" });
  expect(argv[0]).toEqual(expect.arrayContaining(["--state", "all", "--head", B, "--repo", "o/r"]));
  expect(await p.branch("o/r", "main")).toMatchObject({ state: "unknown" });
  expect(await p.prs("not a repo", B)).toMatchObject({ state: "unknown" });
  expect(argv).toHaveLength(1);
});
