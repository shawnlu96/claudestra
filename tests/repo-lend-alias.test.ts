import { afterEach, expect, test } from "bun:test";
import { setRepoAliasForTest } from "../src/lib/repo-alias.js";
import { admitOrders } from "../src/lib/lend-inbox.js";
import { scopeProblem } from "../src/lib/lend-grant-rules.js";
import { claimProblem, claimOrder } from "../src/lib/lend-drive.js";
import { getOrder, recordAsked } from "../src/lib/lend-journal.js";
import { ENTRY, FP, harness, polled } from "./lend-harness.js";

const old = "shawnlu96/claudestra", renamed = "floka-ai/floka";
afterEach(() => setRepoAliasForTest({ mode: null, sink: null }));

for (const mode of ["off", "observe", "on"] as const) {
  for (const [grant, repo] of [[old, renamed], [renamed, old], [old, old],
    [renamed, "shawnlu96/other"], [old, "floka-ai/other"], [old, "fork/floka"], [old, "fork/claudestra"]]) {
    test(`[1,4] ${mode}: inbox / grant / claim ${grant} -> ${repo}`, async () => {
      setRepoAliasForTest({ mode, sink: () => {} });
      const allowed = grant === repo || mode === "on" && [old, renamed].includes(repo);
      const h = harness({ entry: { repos: [grant] } });
      try {
        const order = { ...polled(), repo };
        const result = await admitOrders(h.d, { peer: "team-a", fp: FP }, [order], "poll");
        expect(result.accepted.length).toBe(allowed ? 1 : 0);
        expect(scopeProblem({ ...ENTRY, repos: [grant] }, order) === null).toBe(allowed);
        if (!allowed) recordAsked(h.db, { orderId: "o1", peer: "team-a", fp: FP, family: "codex", preview: order }, h.d.now());
        const row = getOrder(h.db, "o1")!;
        expect(claimProblem(row, h.lend.lend[0], h.db, h.d.now()) === null).toBe(allowed);
        expect(row.preview.repo).toBe(repo);
      } finally { h.db.close(); }
    });
  }
}
test("[4] claim snapshot integrity remains exact even with alias on", async () => {
  setRepoAliasForTest({ mode: "on" });
  const h = harness();
  try {
    recordAsked(h.db, { orderId: "o1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled(), repo: renamed } }, h.d.now());
    await claimOrder(getOrder(h.db, "o1")!, h.d);
    expect(getOrder(h.db, "o1")!.state).toBe("released");
    expect(h.calls.some((c) => c.op === "lease")).toBe(true);
  } finally { h.db.close(); }
});
