import { testChildEnv } from "./test-env.ts";
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
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      cwd: process.cwd(), env: testChildEnv({ HOME: dir, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime"), DISCORD_CHANNEL_ID: "" }), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("live-offer-passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const scenario of ["joined", "service", "restricted", "wrong-person", "display"] as const) {
  test(`live new-project receiver ${scenario}: stored owner approval, canonical grant and sole N2 writer`, async () => {
    const root = mkdtempSync(join(tmpdir(), "n4-project-live-")), dir = join(root, "state"), home = join(root, "home");
    try {
      const script = `
        import assert from "node:assert/strict";
        import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
        import { createV2ProjectsFixtures } from "./src/lib/shared-ledger-contract-v2-projects-fixtures.ts";
        import { SHARED_LEDGER_LIST_FIXTURE } from "./src/lib/shared-ledger-contract-fixtures.ts";
        import { instanceIdSync } from "./src/lib/instance-id.ts";
        import { setAsksForTest, askDb } from "./src/bridge/asks.ts";
        import { listAsks, answerAsk } from "./src/lib/ledger-asks.ts";
        import { readSharedLedgerBindings } from "./src/lib/shared-ledger-gate-bindings.ts";
        import { receiveJoinOffer, joinOfferLiveDeps, onJoinOfferAnswered } from "./src/bridge/shared-ledger-join-offer.ts";
        const dir = process.env.CLAUDESTRA_STATE_DIR, scenario = ${JSON.stringify(scenario)}, f = createV2ProjectsFixtures();
        mkdirSync(dir, { recursive: true });
        writeFileSync(dir + "/projects.json", JSON.stringify({ projects: [] }));
        writeFileSync(dir + "/principals.json", JSON.stringify({ principals: [{ id: "owner:self", role: "owner", agents: ["*"],
          manage: scenario !== "restricted", createdAt: "" }] }), { mode: 0o600 });
        setAsksForTest({ path: dir + "/cards.sqlite" });
        const instanceId = instanceIdSync(dir), statuses = [], informs = []; let exchanges = 0;
        globalThis.fetch = async (url, init) => {
          assert.equal(url.origin, "https://synthetic.example");
          assert.equal(init.redirect, "error");
          if (url.pathname === "/v1/join") {
            exchanges++;
            const input = JSON.parse(init.body);
            assert.equal(input.instanceId, instanceId);
            assert.ok(input.signature && input.publicKey);
            return Response.json({ ...f.grant, instanceId, expiresAt: Date.now() + 60000,
              personId: scenario === "wrong-person" ? "other-person" : f.grant.personId,
              project: { ...f.grant.project, name: scenario === "display" ? "wrong display" : f.grant.project.name },
              role: scenario === "service" ? "service" : "member" });
          }
          assert.equal(url.pathname, "/v1/teams/" + f.identity.teamId + "/features");
          return Response.json({ ...SHARED_LEDGER_LIST_FIXTURE, teamId: f.identity.teamId, features: [] });
        };
        const peer = { name: "synthetic-peer", baseUrl: "https://peer.example/", outToken: "synthetic", addedAt: "" };
        const d = { ...joinOfferLiveDeps, peers: async () => [peer], inform: async text => { informs.push(text); },
          sendReceipt: async (_peer, body) => { statuses.push(JSON.parse(body).status); return 200; } };
        const body = { v: 1, offerId: "b".repeat(32), url: "https://synthetic.example/", code: f.creatorInvite.code,
          project: f.display, projectInvite: { ...f.creatorInvite, instanceId: null, expiresAt: Date.now() + 60000 } };
        assert.equal((await receiveJoinOffer(peer, body, d)).status, 202);
        const a = listAsks(askDb())[0];
        assert.ok(!JSON.stringify(a).includes(body.code));
        const approved = answerAsk(askDb(), a.id, { choices: ["[select:shared_project_local:create]", "[button:sl_join_accept]"],
          labels: [], text: "", principal: "owner:self", owner: true, via: "web_card", at: Date.now(), final: true });
        await onJoinOfferAnswered(approved, d);
        assert.deepEqual(statuses, [scenario === "joined" ? "joined" : "failed"]);
        assert.equal(readSharedLedgerBindings(dir).length, scenario === "joined" ? 1 : 0);
        assert.equal(exchanges, scenario === "restricted" ? 0 : 1);
        assert.equal(existsSync(dir + "/shared-ledger-credentials.json"), scenario === "joined");
        for (const file of readdirSync(dir)) {
          if (file === "runtime") continue;
          const text = readFileSync(dir + "/" + file).toString("utf8");
          assert.ok(!text.includes(body.code), file);
          if (file !== "shared-ledger-credentials.json") assert.ok(!text.includes(f.grant.bearer), file);
        }
        assert.ok(!JSON.stringify(informs).includes(body.code));
        console.log("actual-project-offer-passed");
      `;
      const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: process.cwd(),
        env: testChildEnv({ HOME: home, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"), DISCORD_CHANNEL_ID: "" }),
        stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(stdout).toContain("actual-project-offer-passed");
      expect(stdout).not.toContain("F".repeat(43));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
