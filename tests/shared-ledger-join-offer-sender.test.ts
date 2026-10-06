import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpPeer } from "../src/lib/peers.js";
import type { Principal } from "../src/lib/principals.js";
import { readSentOffer, sentOfferDir, type SentJoinOffer } from "../src/lib/shared-ledger-join-offer.js";
import { joinOfferLiveDeps } from "../src/bridge/shared-ledger-join-offer.js";
import { handleJoinOfferApi, type JoinOfferRouteDeps } from "../src/bridge/local-api/shared-ledger-join-offer.js";
import { cmdSharedLedgerOffer, sendSharedLedgerOffer, parseOfferArgs, type OfferDeps } from "../src/manager/shared-ledger-offer.js";

const MARK = "JN3MARKERJN3MARKERJN3MARKERJN3MARKERJN3MARK";
const hex = () => randomBytes(16).toString("hex");
const code = `sljoin1.center-${hex()}.${hex()}.${MARK}`;
const root = mkdtempSync(join(tmpdir(), "sl-join-offer-send-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let out: string[] = [];
let spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  out = [];
  spies = (["log", "error", "warn", "info"] as const).map((m) => spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); }));
});
afterEach(() => { for (const s of spies) s.mockRestore(); });

const peerA: HttpPeer = { name: "peer-a", baseUrl: "https://peer-a.example", outToken: "out-token-peer-a-0000", addedAt: "2026-10-01T00:00:00Z" };
function codeFile(mode: number, content = `${code}\n`): string {
  const f = join(mkdtempSync(join(root, "code-")), "join-code");
  writeFileSync(f, content, { mode });
  return f;
}

/** 本机 (sender): fake peer lookup, project list and transport; records every POST. */
function sender(peer: HttpPeer | null = peerA, status = 202) {
  const posts: { peer: string; url: string; body: string }[] = [];
  const deps: OfferDeps = {
    stateDir: mkdtempSync(join(root, "send-")), now: Date.now(), findPeer: async () => peer,
    callerProject: async () => "proj-local", projectExists: async (id) => id === "proj-local",
    post: async (p, url, body) => { posts.push({ peer: p.name, url, body }); return Response.json({ ok: status === 202, code: status === 202 ? undefined : "rate_limited" }, { status }); },
  };
  return { deps, posts };
}
const lastOutput = () => JSON.parse(out.at(-1)!) as Record<string, unknown>;

describe("sender CLI (验收 5)", () => {
  test("a join code anywhere in argv is refused before anything is read or sent", async () => {
    expect(parseOfferArgs(["--peer", "peer-a", "--url", "https://ledger-a.example/", "--code-file", code])).toContain("命令行");
    const s = sender();
    await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example/", "--code-file", "/x", "--note", code], s.deps);
    expect(lastOutput()).toMatchObject({ ok: false });
    expect(s.posts).toEqual([]);
    expect(out.join("\n").includes(MARK)).toBe(false);
  });

  test("--code-file that is not 0600 is refused", async () => {
    for (const mode of [0o644, 0o640, 0o604]) {
      const s = sender();
      await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example/", "--code-file", codeFile(mode)], s.deps);
      expect(lastOutput()).toEqual({ ok: false, error: "join code file must be a regular 0600 file owned by this user" });
      expect(s.posts).toEqual([]);
    }
  });

  test("0600 file → one POST to the peer's offer route carrying the code; nothing secret in stdout; sent record without the code", async () => {
    const s = sender();
    await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example", "--code-file", codeFile(0o600), "--task", "JN3"], s.deps);
    const r = lastOutput();
    expect(r).toMatchObject({ ok: true, accepted: true, joined: false, peer: "peer-a", centerHost: "ledger-a.example", receiptProject: "proj-local" });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.url).toBe("https://peer-a.example/api/v1/shared-ledger-join-offer");
    const body = JSON.parse(s.posts[0]!.body);
    expect(Object.keys(body).sort()).toEqual(["code", "expiresAt", "note", "offerId", "url", "v"]);
    expect(body).toMatchObject({ v: 1, offerId: r.offerId, url: "https://ledger-a.example/", code });
    expect(out.join("\n").includes(MARK)).toBe(false);
    const file = join(sentOfferDir(s.deps.stateDir), `${r.offerId}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").includes(MARK)).toBe(false);
    expect(readSentOffer(s.deps.stateDir, r.offerId as string)).toMatchObject({ peer: "peer-a", host: "ledger-a.example", project: "proj-local", target: "JN3" });
  });

  test("center response code goes directly from memory to peer without a code file", async () => {
    const s = sender();
    const r = await sendSharedLedgerOffer({ peer: "peer-a", url: "https://ledger-a.example/" }, code, s.deps);
    expect(r).toMatchObject({ ok: true, accepted: true, joined: false });
    expect(s.posts).toHaveLength(1);
    expect(JSON.parse(s.posts[0]!.body).code).toBe(code);
    expect(readdirSync(s.deps.stateDir)).toEqual(["shared-ledger-join-offers-sent"]);
    const file = join(sentOfferDir(s.deps.stateDir), `${r.offerId}.json`);
    expect(readFileSync(file, "utf8")).not.toContain(MARK);
    expect(JSON.stringify([out, r])).not.toContain(MARK);
    const rejected = await sendSharedLedgerOffer({ peer: "peer-a", url: "https://ledger-a.example/", note: code }, code, s.deps);
    expect(rejected.ok).toBe(false);
    expect(s.posts).toHaveLength(1);
  });

  test("http center URL, a plaintext peer, or a peer that refuses → not sent / reported as not accepted", async () => {
    const http = sender();
    await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "http://ledger-a.example/", "--code-file", codeFile(0o600)], http.deps);
    expect(lastOutput().ok).toBe(false);
    expect(http.posts).toEqual([]);
    const plain = sender({ ...peerA, baseUrl: "http://100.64.0.2:3848" });
    await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example/", "--code-file", codeFile(0o600)], plain.deps);
    expect(String(lastOutput().error)).toContain("不走明文");
    expect(plain.posts).toEqual([]);
    const busy = sender(peerA, 429);
    await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example/", "--code-file", codeFile(0o600)], busy.deps);
    expect(lastOutput()).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
    expect(out.join("\n").includes(MARK)).toBe(false);
  });
});

describe("receipt from the peer (回执)", () => {
  async function sentWorld() {
    const s = sender();
    await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example/", "--code-file", codeFile(0o600)], s.deps);
    const offerId = lastOutput().offerId as string;
    const notes: { sent: SentJoinOffer; text: string }[] = [];
    const principal = (peer: string): Principal => ({ id: `token:${peer}`, role: "external", agents: [], createdAt: "", peer });
    const deps: JoinOfferRouteDeps = {
      ...joinOfferLiveDeps, stateDir: () => s.deps.stateDir, now: () => Date.now(),
      peers: async () => [peerA, { ...peerA, name: "peer-other" }],
      auth: async (req) => principal(req.headers.get("x-test-peer") ?? ""),
      writeNote: async (sent, text) => { notes.push({ sent, text }); },
    };
    const receipt = async (peer: string, body: unknown) => {
      const url = new URL("http://127.0.0.1/api/v1/shared-ledger-join-offer/receipt");
      const req = new Request(url.toString(), { method: "POST", headers: { "x-test-peer": peer, "content-type": "application/json" }, body: JSON.stringify(body) });
      return (await handleJoinOfferApi(req, url, deps))!;
    };
    return { offerId, notes, receipt, dir: s.deps.stateDir };
  }

  test("joined from the same peer → one ledger note in the receipt project; repeats are idempotent", async () => {
    const w = await sentWorld();
    const r = await w.receipt("peer-a", { v: 1, offerId: w.offerId, status: "joined" });
    expect([r.status, await r.json()]).toEqual([200, { ok: true, duplicate: false }]);
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]!.sent).toMatchObject({ project: "proj-local", target: "", status: "joined" });
    expect(w.notes[0]!.text).toBe(`共享台账入组回执：peer-a 已入组（joined；中心 ledger-a.example；offer ${w.offerId}）`);
    expect((await w.receipt("peer-a", { v: 1, offerId: w.offerId, status: "joined" })).status).toBe(200);
    expect((await w.receipt("peer-a", { v: 1, offerId: w.offerId, status: "failed" })).status).toBe(404);
    expect(w.notes).toHaveLength(1);
    expect(out.join("\n").includes(MARK)).toBe(false);
  });

  test("another peer, an unknown offer, a fifth status or extra fields are refused; unconfigured peers get 403", async () => {
    const w = await sentWorld();
    expect((await w.receipt("peer-other", { v: 1, offerId: w.offerId, status: "declined" })).status).toBe(404);
    expect((await w.receipt("peer-a", { v: 1, offerId: hex(), status: "declined" })).status).toBe(404);
    expect((await w.receipt("peer-a", { v: 1, offerId: w.offerId, status: "pending" })).status).toBe(400);
    expect((await w.receipt("peer-a", { v: 1, offerId: w.offerId, status: "declined", detail: "x" })).status).toBe(400);
    expect((await w.receipt("peer-stranger", { v: 1, offerId: w.offerId, status: "declined" })).status).toBe(403);
    expect(w.notes).toEqual([]);
    expect(readSentOffer(w.dir, w.offerId)!.status).toBeUndefined();
    for (const status of ["declined", "expired"] as const) {
      const x = await sentWorld();
      expect((await x.receipt("peer-a", { v: 1, offerId: x.offerId, status })).status).toBe(200);
      expect(x.notes.map((n) => n.sent.status)).toEqual([status]);
    }
    expect(existsSync(w.dir) && readdirSync(sentOfferDir(w.dir))).toHaveLength(1);
  });
});

test("CLI cannot turn declared project metadata into a verified center invite", async () => {
  const s = sender();
  await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example", "--code-file", codeFile(0o600),
    "--team", "team-a", "--shared-project", "project-b", "--name", "Project B"], s.deps);
  expect(lastOutput().ok).toBe(false);
  expect(s.posts).toEqual([]);
  const incomplete = sender();
  await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example", "--code-file", codeFile(0o600), "--team", "team-a"], incomplete.deps);
  expect(lastOutput().ok).toBe(false);
  expect(incomplete.posts).toEqual([]);
});
