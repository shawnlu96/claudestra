import { describe, expect, test } from "bun:test";
import { ghFixStartProbe, probeFixStart } from "../src/lib/lend-fix-start.js";
import type { WriteProbe } from "../src/lib/lend-write-materials.js";

const H2 = "2".repeat(40), H3 = "3".repeat(40);
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });
const probe: WriteProbe = {
  peerFp: async () => "fingerprint",
  remoteHead: async () => { throw new Error("Git remote probe must not run for a production fix start"); },
};

describe("shared FB1 / RA1 production head probe", () => {
  test("gh API reads the branch ref before compare; Git credentials are not needed", async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      return ok(args[1].includes("/compare/") ? "ahead\n" : `${H3}\n`);
    };
    const shared = ghFixStartProbe(probe, gh);
    expect(shared.peerFp).toBe(probe.peerFp);
    expect(await probeFixStart("o/r", "lend/T1-abcd", H2, shared.remoteHead, gh)).toEqual({ ok: true, from: H2, head: H3 });
    expect(calls).toEqual([
      ["api", "repos/o/r/git/ref/heads/lend/T1-abcd", "--jq", ".object.sha"],
      ["api", `repos/o/r/compare/${H2}...${H3}`, "--jq", ".status"],
    ]);
  });

  test.each([
    { code: 1, stdout: "", stderr: "HTTP 502", timedOut: false },
    { ...ok(H3), timedOut: true }, ok(""), ok("abc"),
  ])("failed / malformed gh head leaves the old start and never compares: %j", async (result) => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => { calls.push(args); return result; };
    const shared = ghFixStartProbe(probe, gh);
    expect(await probeFixStart("o/r", "lend/T1-abcd", H2, shared.remoteHead, gh))
      .toMatchObject({ ok: false, from: H2, head: null, why: expect.stringContaining("gh head 查询失败") });
    expect(calls).toHaveLength(1);
  });

  test("escapes URL characters in the ref while retaining branch slashes", async () => {
    const calls: string[][] = [];
    const shared = ghFixStartProbe(probe, async (args) => { calls.push(args); return ok(H2); });
    expect(await shared.remoteHead("o/r", "lend/T1-#%")).toEqual({ ok: true, head: H2 });
    expect(calls[0][1]).toBe("repos/o/r/git/ref/heads/lend/T1-%23%25");
  });
});
