import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("live receiver infers same-id choice from one existing center binding without new invitation fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-offer-live-"));
  try {
    const script = `
      import assert from "node:assert/strict";
      import { writeProjects } from "./src/lib/projects.ts";
      import { writeFileSync } from "node:fs";
      import { askDb, setAsksForTest } from "./src/bridge/asks.ts";
      import { listAsks } from "./src/lib/ledger-asks.ts";
      import { receiveJoinOffer, joinOfferLiveDeps, onJoinOfferAnswered } from "./src/bridge/shared-ledger-join-offer.ts";
      const dir = process.env.CLAUDESTRA_STATE_DIR, centerId = "center-" + "a".repeat(32), selected = [];
      await writeProjects({ projects: ["other", "shared"].map(id => ({ id, name: id, dirs: [], createdAt: "" })) });
      // Historical dangling state is fixture data, never a mapping installed through the product setter.
      writeFileSync(dir + "/shared-ledger-bindings.json", JSON.stringify([
        { centerId, teamId: "team", projectId: "shared", localProjectId: "old-missing" },
      ]), { mode: 0o600 });
      setAsksForTest({ path: dir + "/cards.sqlite" });
      const peer = { name: "fixture", baseUrl: "https://peer.example", outToken: "fixture", addedAt: "" };
      const d = { ...joinOfferLiveDeps, peers: async () => [peer], inform: async () => {}, sendReceipt: async () => 200,
        join: async (url, code, localProjectId) => { selected.push(localProjectId); return { centerId, teamId: "team", projectId: "shared" }; } };
      const body = { v: 1, offerId: "b".repeat(32), url: "https://center.example/",
        code: "sljoin1." + centerId + "." + "c".repeat(32) + "." + "M".repeat(43) };
      assert.equal((await receiveJoinOffer(peer, body, d)).status, 202);
      const a = listAsks(askDb())[0];
      assert.equal(a.options[0].buttons[0].label, "加入并绑到 shared（同名）");
      assert.equal(a.options[0].buttons[1].label, "加入并绑到 other");
      assert.ok(a.context.includes("根据已有绑定"));
      await onJoinOfferAnswered({ ...a, state: "answered", answer: { choices: ["[button:sl_join_accept]"],
        labels: ["shared"], text: "", principal: "owner:self", via: "web_card", at: Date.now(), owner: true } }, d);
      assert.deepEqual(selected, ["shared"]);
      console.log("live-offer-passed");
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(), env: { ...process.env, CLAUDESTRA_STATE_DIR: dir, DISCORD_CHANNEL_ID: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("live-offer-passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
