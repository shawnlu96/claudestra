import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdmin } from "../scripts/shared-ledger-admin.js";
import { LedgerService } from "../src/shared-ledger/service.js";
import { startServer } from "../src/shared-ledger/server.js";
import { Store } from "../src/shared-ledger/store.js";
import type { InstanceKey } from "../src/lib/instance-key.js";
import type { Ask } from "../src/lib/ledger-asks.js";
import type { HttpPeer } from "../src/lib/peers.js";
import type { Principal } from "../src/lib/principals.js";
import { joinSharedLedger, parseSharedLedgerJoinCode } from "../src/lib/shared-ledger-join.js";
import { centerOfferUrl, pendingOfferDir, readPendingOffer, savePendingOffer } from "../src/lib/shared-ledger-join-offer.js";
import { resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { DECLINE_BUTTON, JOIN_BUTTON, onJoinOfferAnswered, sweepJoinOffers } from "../src/bridge/shared-ledger-join-offer.js";
import { handleJoinOfferApi, type JoinOfferRouteDeps } from "../src/bridge/local-api/shared-ledger-join-offer.js";

const MARK = "JN3MARKERJN3MARKERJN3MARKERJN3MARKERJN3MARK"; // 43 chars: a valid secret that is easy to grep for
const hex = () => randomBytes(16).toString("hex");
const markedCode = () => `sljoin1.center-${hex()}.${hex()}.${MARK}`;
const newKey = (): InstanceKey => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};

let root: string, centerDb: string, store: Store, server: ReturnType<typeof startServer>, centerHttp: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sl-join-offer-"));
  centerDb = join(root, "center.sqlite");
  store = new Store(centerDb);
  server = startServer(new LedgerService(store));
  centerHttp = `http://127.0.0.1:${server.port}`;
});
afterAll(() => { server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });

const mint = (person: string) => String(runAdmin(["invite", "--db", centerDb, "--team", "team-a", "--project", "project-a", "--person", person,
  "--code", person, "--role", "member", "--actions", "read,plan", "--ttl", "24h"]).joinCode);

/** Log capture: everything any console method printed during a test, for the "no secret in logs" checks. */
let logs: string[] = [];
let spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  logs = [];
  spies = (["log", "error", "warn", "info"] as const).map((m) => spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
});
afterEach(() => { for (const s of spies) s.mockRestore(); });

interface World {
  deps: JoinOfferRouteDeps; dir: string; joinDir: string; asks: Ask[]; informs: string[]; receipts: { peer: string; body: string }[];
  joins: { url: string; code: string }[]; requestedHosts: string[]; clock: { now: number }; centers: string[];
}

/** A receiving machine ("本机") with one configured peer ("peer A" under the given name); the center is the local test server. */
function world(peerName: string, centerFetch?: typeof fetch): World {
  const dir = mkdtempSync(join(root, "recv-")), joinDir = mkdtempSync(join(root, "join-"));
  const asks: Ask[] = [], informs: string[] = [], receipts: World["receipts"] = [], joins: World["joins"] = [], requestedHosts: string[] = [];
  const clock = { now: Date.now() }, centers: string[] = [];
  const peers: HttpPeer[] = [{ name: peerName, baseUrl: "https://peer-a.example", outToken: "out-token-peer-a-0000", addedAt: "2026-10-01T00:00:00Z" }];
  const rewrite = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    requestedHosts.push(u.host);
    return fetch(`${centerHttp}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
  const key = newKey();
  const principals: Record<string, Principal> = {
    "in-peer": { id: "token:tin", role: "external", agents: [], createdAt: "", peer: peerName },
    "in-stranger": { id: "token:tst", role: "external", agents: [], createdAt: "", peer: "peer-unconfigured" },
    "owner": { id: "token:town", role: "owner", agents: ["*"], createdAt: "" },
  };
  const deps: JoinOfferRouteDeps = {
    auth: async (req) => {
      const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
      if (!m) return Response.json({ ok: false }, { status: 401 });
      return principals[m[1]!] ?? Response.json({ ok: false }, { status: 401 });
    },
    stateDir: () => dir,
    now: () => clock.now,
    projects: async () => [{ id: "project-a", name: "project-a", lastActivityAt: 0 }],
    sharedProject: () => "project-a",
    // The receiver already holds the exact project-a binding at the center of the latest offer, so the default offer has a hint.
    bindings: () => centers.slice(-1).map(centerId => ({ centerId, teamId: "team-a", projectId: "project-a", localProjectId: "project-a" })),
    peers: async () => peers,
    openAsk: (input) => {
      const a = { ...input, id: `ask_${asks.length + 1}`, state: "open", answer: null, fromAgent: null, fromChannelId: null, extra: input.extra ?? {},
        createdAt: clock.now, updatedAt: clock.now, expiresAt: input.expiresAt ?? clock.now + 3600_000 } as unknown as Ask;
      asks.push(a);
      return a;
    },
    getAsk: (id) => asks.find((a) => a.id === id) ?? null,
    closeAsk: (id) => { const a = asks.find((x) => x.id === id); if (a) a.state = "cancelled"; },
    join: async (url, code, localProjectId) => {
      joins.push({ url, code });
      return joinSharedLedger({ url, code, key, instanceId: `instance-${peerName}`, subject: "owner:self", localProjectId, stateDir: joinDir, fetch: centerFetch ?? rewrite });
    },
    inform: async (text) => { informs.push(text); },
    sendReceipt: async (peer, body) => { receipts.push({ peer: peer.name, body }); return 200; },
    writeNote: async () => { throw new Error("receiver never writes notes"); },
  };
  return { deps, dir, joinDir, asks, informs, receipts, joins, requestedHosts, clock, centers };
}

const offerBody = (code: string, over: Record<string, unknown> = {}) => ({ v: 1, offerId: hex(), url: "https://ledger-a.example/", code, note: "来自 peer A 的邀请", ...over });
async function post(w: World, token: string | null, body: unknown, path = "/api/v1/shared-ledger-join-offer"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const url = new URL(`http://127.0.0.1${path}`);
  const center = parseSharedLedgerJoinCode((body as { code?: unknown } | null)?.code);
  if (center) w.centers.push(center.centerId);
  return (await handleJoinOfferApi(new Request(url.toString(), { method: "POST", headers, body: JSON.stringify(body) }), url, w.deps))!;
}
const pendingFiles = (w: World) => (existsSync(pendingOfferDir(w.dir)) ? readdirSync(pendingOfferDir(w.dir)) : []);
function answer(a: Ask, button: string, owner = true): Ask {
  return { ...a, state: "answered", answer: { choices: [`[button:${button}]`], labels: [button === JOIN_BUTTON ? "加入" : "不加入"], text: "",
    principal: owner ? "owner:self" : "guest:abc", via: "web_card", at: Date.now(), ...(owner ? { owner: true as const } : { external: true }) } };
}
/** The exact center/team/project binding that lets an offer naming project-a carry the same-id hint (JN4H). */
const bindProjectA = (w: World, code: string, localProjectId = "project-a") => {
  w.deps.bindings = () => [{ centerId: parseSharedLedgerJoinCode(code)!.centerId, teamId: "team-a", projectId: "project-a", localProjectId }];
};
const receiptStatus = (w: World) => w.receipts.map((r) => JSON.parse(r.body).status);

describe("receiving a join offer (验收 1)", () => {
  test("configured peer → 0600 pending file + authorize card with peer, center host and a marked same-id join / 不加入", async () => {
    const w = world("peer-a1");
    const body = offerBody(markedCode());
    const res = await post(w, "in-peer", body);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, accepted: true, offerId: body.offerId });
    const file = join(pendingOfferDir(w.dir), `${body.offerId}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(pendingOfferDir(w.dir)).mode & 0o777).toBe(0o700);
    expect(readPendingOffer(w.dir, body.offerId as string)).toMatchObject({ peer: "peer-a1", host: "ledger-a.example", code: body.code, askId: "ask_1" });
    const [card] = w.asks;
    expect(card).toMatchObject({ kind: "authorize", source: "system", title: "加入共享台账？" });
    expect(card!.context).toContain("邀请方（peer）：peer-a1");
    expect(card!.context).toContain("中心主机：ledger-a.example");
    expect(card!.context).toContain(`中心 ID：${parseSharedLedgerJoinCode(body.code as string)!.centerId}`);
    expect(card!.context).toContain("团队 / 项目：入组后显示");
    expect(card!.options).toEqual([{ type: "buttons", buttons: [{ id: JOIN_BUTTON, label: "加入并绑到 project-a（同名）", style: "success" }, { id: DECLINE_BUTTON, label: "不加入", style: "secondary" }] }]);
    expect(card!.expiresAt).toBeLessThanOrEqual(w.clock.now + 24 * 3600_000);
  });

  test("unconfigured peer token, owner token or no token → 403 and nothing stored", async () => {
    const w = world("peer-a2");
    for (const token of ["in-stranger", "owner", "revoked-token", null]) {
      const res = await post(w, token, offerBody(markedCode()));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("peer_only");
    }
    expect(pendingFiles(w)).toEqual([]);
    expect(w.asks).toEqual([]);
  });

  test("more than 5 offers from one peer within an hour → 429; another peer is unaffected", async () => {
    const w = world("peer-a3");
    for (let i = 0; i < 5; i++) expect((await post(w, "in-peer", offerBody(markedCode()))).status).toBe(202);
    const sixth = await post(w, "in-peer", offerBody(markedCode()));
    expect(sixth.status).toBe(429);
    expect(pendingFiles(w)).toHaveLength(5);
    const other = world("peer-a3-other");
    expect((await post(other, "in-peer", offerBody(markedCode()))).status).toBe(202);
  });

  test("the same offerId twice → 409, one file", async () => {
    const w = world("peer-a4");
    const body = offerBody(markedCode());
    expect((await post(w, "in-peer", body)).status).toBe(202);
    expect((await post(w, "in-peer", body)).status).toBe(409);
    expect(pendingFiles(w)).toHaveLength(1);
  });
});

describe("owner answers the card (验收 2)", () => {
  test("deduplicated settled offer ID cannot redeem or decline a replacement code", async () => {
    for (const button of [JOIN_BUTTON, DECLINE_BUTTON]) {
      const w = world(`peer-reuse-${button}`);
      const body = offerBody(mint(`peer-reuse-${button}`), { expiresAt: w.clock.now + 60000 });
      const open = w.deps.openAsk;
      w.deps.openAsk = input => w.asks.find(a => a.dedupKey === input.dedupKey) ?? open(input);
      expect((await post(w, "in-peer", body)).status).toBe(202);
      w.asks[0] = answer(w.asks[0]!, button);
      await onJoinOfferAnswered(w.asks[0]!, w.deps);
      const replacement = { ...body, code: mint(`peer-new-${button}`) };
      expect((await post(w, "in-peer", replacement)).status).toBe(409);
      await sweepJoinOffers(w.deps);
      expect(w.asks).toHaveLength(1);
      expect(w.joins).toHaveLength(button === JOIN_BUTTON ? 1 : 0);
      expect(receiptStatus(w)).toEqual([button === JOIN_BUTTON ? "joined" : "declined"]);
      expect(pendingFiles(w)).toEqual([]);
    }
  });

  test("authorization binds the exact code even within the same center", async () => {
    const w = world("peer-code-binding");
    const body = offerBody(markedCode());
    expect((await post(w, "in-peer", body)).status).toBe(202);
    const p = readPendingOffer(w.dir, body.offerId)!;
    const replacement = p.code.replace(MARK, "N".repeat(43));
    await savePendingOffer(w.dir, { ...p, code: replacement }, { replace: true });
    await onJoinOfferAnswered(answer(w.asks[0]!, JOIN_BUTTON), w.deps);
    expect(w.joins).toEqual([]);
    expect(receiptStatus(w)).toEqual(["failed"]);
    expect(pendingFiles(w)).toEqual([]);
  });

  test("answer during publication cannot resurrect pending or settle twice", async () => {
    for (const button of [DECLINE_BUTTON, JOIN_BUTTON]) {
      const w = world(`peer-race-${button}`);
      const body = offerBody(button === JOIN_BUTTON ? mint("peer-race") : markedCode());
      const open = w.deps.openAsk;
      let answering: Promise<void> | undefined;
      w.deps.openAsk = (input) => {
        const a = answer(open(input), button);
        w.asks[0] = a;
        answering = onJoinOfferAnswered(a, w.deps);
        return a;
      };
      expect((await post(w, "in-peer", body)).status).toBe(409);
      await answering;
      expect(readPendingOffer(w.dir, body.offerId)).toBeNull();
      await sweepJoinOffers(w.deps);
      await onJoinOfferAnswered(w.asks[0]!, w.deps);
      expect(receiptStatus(w)).toEqual([button === JOIN_BUTTON ? "joined" : "declined"]);
      expect(w.joins).toHaveLength(button === JOIN_BUTTON ? 1 : 0);
    }
  });

  test("加入 → joinSharedLedger against the (fake-host) center, credential written, receipt joined, inform card", async () => {
    const w = world("peer-b1");
    const code = mint("peer-b1");
    const body = offerBody(code);
    expect((await post(w, "in-peer", body)).status).toBe(202);
    await onJoinOfferAnswered(answer(w.asks[0]!, JOIN_BUTTON), w.deps);
    expect(w.joins).toEqual([{ url: "https://ledger-a.example/", code }]);
    const centerId = parseSharedLedgerJoinCode(code)!.centerId;
    expect(resolveSharedLedgerCredential("owner:self", "person", centerId, "team-a", "project-a", "plan", w.joinDir)).not.toBeNull();
    expect(pendingFiles(w)).toEqual([]);
    expect(w.receipts).toEqual([{ peer: "peer-b1", body: JSON.stringify({ v: 1, offerId: body.offerId, status: "joined" }) }]);
    expect(w.informs).toHaveLength(1);
    expect(w.informs[0]).toContain("团队 team-a，项目 project-a");
    // A second click / the sweeper finds nothing left to redeem.
    await onJoinOfferAnswered(answer(w.asks[0]!, JOIN_BUTTON), w.deps);
    await sweepJoinOffers(w.deps);
    expect(w.joins).toHaveLength(1);
    expect(w.receipts).toHaveLength(1);
  });

  test("不加入 → pending deleted, receipt declined, joinSharedLedger not called", async () => {
    const w = world("peer-b2");
    expect((await post(w, "in-peer", offerBody(markedCode()))).status).toBe(202);
    await onJoinOfferAnswered(answer(w.asks[0]!, DECLINE_BUTTON), w.deps);
    expect(pendingFiles(w)).toEqual([]);
    expect(receiptStatus(w)).toEqual(["declined"]);
    expect(w.joins).toEqual([]);
  });

  test("expired → sweeper deletes the file, cancels the open card, receipt expired, joinSharedLedger not called", async () => {
    const w = world("peer-b3");
    expect((await post(w, "in-peer", offerBody(markedCode(), { expiresAt: w.clock.now + 60_000 }))).status).toBe(202);
    await sweepJoinOffers(w.deps);
    expect(pendingFiles(w)).toHaveLength(1); // not yet due
    w.clock.now += 61_000;
    await sweepJoinOffers(w.deps);
    expect(pendingFiles(w)).toEqual([]);
    expect(w.asks[0]!.state).toBe("cancelled");
    expect(receiptStatus(w)).toEqual(["expired"]);
    expect(w.joins).toEqual([]);
  });

  test("加入 after the offer expired → expired, no redemption", async () => {
    const w = world("peer-b4");
    expect((await post(w, "in-peer", offerBody(markedCode(), { expiresAt: w.clock.now + 60_000 }))).status).toBe(202);
    w.clock.now += 120_000;
    await onJoinOfferAnswered(answer(w.asks[0]!, JOIN_BUTTON), w.deps);
    expect(receiptStatus(w)).toEqual(["expired"]);
    expect(w.joins).toEqual([]);
  });

  test("加入 that fails ask-check (not the owner, or params changed) → failed, no redemption", async () => {
    const w = world("peer-b5");
    expect((await post(w, "in-peer", offerBody(markedCode()))).status).toBe(202);
    await onJoinOfferAnswered(answer(w.asks[0]!, JOIN_BUTTON, false), w.deps);
    expect(w.joins).toEqual([]);
    expect(receiptStatus(w)).toEqual(["failed"]);
    expect((await post(w, "in-peer", offerBody(markedCode()))).status).toBe(202);
    const forged = answer(w.asks[1]!, JOIN_BUTTON);
    await onJoinOfferAnswered({ ...forged, bind: { ...forged.bind!, paramsHash: "0".repeat(64) } }, w.deps);
    expect(w.joins).toEqual([]);
    expect(receiptStatus(w)).toEqual(["failed", "failed"]);
  });

  test("an answered card the hook missed (bridge restart) is settled by the sweeper", async () => {
    const w = world("peer-b6");
    expect((await post(w, "in-peer", offerBody(markedCode()))).status).toBe(202);
    w.asks[0] = answer(w.asks[0]!, DECLINE_BUTTON);
    await sweepJoinOffers(w.deps);
    expect(receiptStatus(w)).toEqual(["declined"]);
    expect(pendingFiles(w)).toEqual([]);
  });
});

describe("no secret leaves the pending file (验收 3)", () => {
  test("code, bearer and center response body are absent from logs, cards, informs and receipts", async () => {
    const w = world("peer-c1");
    const code = mint("peer-c1");
    expect((await post(w, "in-peer", offerBody(code))).status).toBe(202);
    await onJoinOfferAnswered(answer(w.asks[0]!, JOIN_BUTTON), w.deps);
    const cred = resolveSharedLedgerCredential("owner:self", "person", parseSharedLedgerJoinCode(code)!.centerId, "team-a", "project-a", "read", w.joinDir)!;
    // Failing center whose body carries a marker.
    const centerBody = "CENTERBODYMARKER-do-not-echo";
    const failing = world("peer-c2", (async () => new Response(centerBody, { status: 403 })) as unknown as typeof fetch);
    expect((await post(failing, "in-peer", offerBody(markedCode()))).status).toBe(202);
    await onJoinOfferAnswered(answer(failing.asks[0]!, JOIN_BUTTON), failing.deps);
    expect(receiptStatus(failing)).toEqual(["failed"]);
    expect(failing.informs[0]).toBe("⚠️ 加入 peer-c2 邀请的共享台账没成功（中心 ledger-a.example），邀请已删除；需要的话请对方重新发码。");
    const visible = JSON.stringify([logs, w.asks, w.informs, w.receipts, failing.asks, failing.informs, failing.receipts]);
    for (const secret of [code, parseSharedLedgerJoinCode(code)!.secret, cred.bearer, MARK, centerBody]) expect(visible.includes(secret)).toBe(false);
  });

  test("a refused offer's error does not echo the body", async () => {
    const w = world("peer-c3");
    const res = await post(w, "in-peer", offerBody(`${markedCode()}x`));
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text.includes(MARK)).toBe(false);
    expect(logs.join("\n").includes(MARK)).toBe(false);
  });
});

describe("URL and code validation (验收 4)", () => {
  test("non-https or non-canonical center URLs and malformed codes are refused, nothing stored", async () => {
    let n = 0;
    const worlds: World[] = [];
    const post1 = (body: unknown) => { const w = world(`peer-d1-${n++}`); worlds.push(w); return post(w, "in-peer", body); }; // fresh peer: no rate limit
    const badUrls = ["http://ledger-a.example/", "https://ledger-a.example/v1", "https://user@ledger-a.example/", "https://ledger-a.example/?x=1",
      "https://LEDGER-A.example/", "https://ledger-a.example\\@evil.example/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/",
      "https://ledger-a.example/#frag", "ftp://ledger-a.example/", "https://-bad-.example/"];
    for (const url of badUrls) {
      const res = await post1(offerBody(markedCode(), { url }));
      expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([400, "invalid_url"]);
    }
    for (const code of ["", "sljoin1.center-zz.aa.bb", ` ${markedCode()}`, `${markedCode()}\n`, markedCode().replace("sljoin1", "sljoin2")]) {
      const res = await post1(offerBody(code));
      expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([400, "invalid_code"]);
    }
    expect((await post1({ ...offerBody(markedCode()), extra: "x" })).status).toBe(400);
    expect((await post1(offerBody(markedCode(), { note: "多行\n附言" }))).status).toBe(400);
    expect((await post1(offerBody(markedCode(), { expiresAt: Date.now() - 1 }))).status).toBe(400);
    for (const w of worlds) expect([pendingFiles(w), w.asks]).toEqual([[], []]);
  });

  test("the host on the card is the host the join actually requests", async () => {
    const w = world("peer-d2");
    expect((await post(w, "in-peer", offerBody(mint("peer-d2"), { url: "https://ledger-a.example" }))).status).toBe(202);
    await onJoinOfferAnswered(answer(w.asks[0]!, JOIN_BUTTON), w.deps);
    expect(receiptStatus(w)).toEqual(["joined"]);
    expect(w.requestedHosts.length).toBeGreaterThan(0);
    expect(new Set(w.requestedHosts)).toEqual(new Set(["ledger-a.example"]));
    expect(w.asks[0]!.context).toContain("中心主机：ledger-a.example");
    expect(centerOfferUrl("https://xn--ldger-bsa.example/")?.host).toBe("xn--ldger-bsa.example");
    expect(centerOfferUrl("https://lédger.example/")).toBeNull(); // IDN is shown only in its punycode form
  });
});

describe("local project selection (JN4)", () => {
  test("same shared project id: marked same-id choice leads and binds that local project", async () => {
    const w = world("peer-jn4-same");
    w.deps.projects = async () => [{ id: "other", name: "Other", lastActivityAt: 100 }, { id: "project-a", name: "本机同名项目", lastActivityAt: 0 }];
    expect((await post(w, "in-peer", offerBody(mint("jn4-same")))).status).toBe(202);
    const card = w.asks[0]!;
    expect(card.context).toContain("共享项目（根据已有绑定）：project-a");
    expect((card.options[0] as { buttons: { label: string }[] }).buttons.map(b => b.label)).toEqual(["加入并绑到 本机同名项目（同名）", "加入并绑到 Other", "不加入"]);
    await onJoinOfferAnswered(answer(card, JOIN_BUTTON), w.deps);
    expect(JSON.parse(readFileSync(join(w.joinDir, "shared-ledger-bindings.json"), "utf8"))[0].localProjectId).toBe("project-a");
  });
  test("old invitation without project metadata: three recent project choices each bind exactly the selected local project", async () => {
    for (let i = 0; i < 3; i++) {
      const w = world(`peer-jn4-choice-${i}`);
      w.deps.sharedProject = undefined;
      w.deps.projects = async () => [0, 1, 2, 3].map(n => ({ id: `local-${n}`, name: `Local ${n}`, lastActivityAt: 10 - n }));
      const body = offerBody(mint(`jn4-choice-${i}`));
      expect((await post(w, "in-peer", body)).status).toBe(202);
      const card = w.asks[0]!;
      expect((card.options[0] as { buttons: { label: string }[] }).buttons.map(b => b.label)).toEqual([
        "加入并绑到 Local 0", "加入并绑到 Local 1", "加入并绑到 Local 2", "不加入",
      ]);
      await onJoinOfferAnswered(answer(card, `${JOIN_BUTTON}_${i}`), w.deps);
      expect(JSON.parse(readFileSync(join(w.joinDir, "shared-ledger-bindings.json"), "utf8"))[0].localProjectId).toBe(`local-${i}`);
      expect(receiptStatus(w)).toEqual(["joined"]);
    }
  });
  test("changing the saved choices or deleting the selected project refuses enrollment", async () => {
    for (const mode of ["changed", "deleted"]) {
      const w = world(`peer-jn4-${mode}`), body = offerBody(markedCode());
      expect((await post(w, "in-peer", body)).status).toBe(202);
      if (mode === "changed") {
        const p = readPendingOffer(w.dir, body.offerId)!;
        await savePendingOffer(w.dir, { ...p, projectChoices: [{ button: JOIN_BUTTON, localProjectId: "other", name: "Other" }] }, { replace: true });
      } else w.deps.projects = async () => [];
      await onJoinOfferAnswered(answer(w.asks[0]!, JOIN_BUTTON), w.deps);
      expect(w.joins).toEqual([]);
      expect(receiptStatus(w)).toEqual(["failed"]);
    }
  });
});


test("legacy pending accept reports failed with reinvite advice, while explicit decline remains declined", async () => {
  for (const button of [JOIN_BUTTON, DECLINE_BUTTON]) {
    const w = world(`peer-legacy-${button}`), body = offerBody(markedCode());
    expect((await post(w, "in-peer", body)).status).toBe(202);
    const p = readPendingOffer(w.dir, body.offerId)!;
    await savePendingOffer(w.dir, { ...p, projectChoices: undefined, sharedProjectId: undefined }, { replace: true });
    await onJoinOfferAnswered(answer(w.asks[0]!, button), w.deps);
    expect(receiptStatus(w)).toEqual([button === JOIN_BUTTON ? "failed" : "declined"]);
    if (button === JOIN_BUTTON) expect(w.informs[0]).toContain("重新发码");
    expect(w.joins).toEqual([]);
  }
});

test("known conflicting binding does not consume an intake choice and invalid binding state gives a fixed refusal", async () => {
  const w = world("peer-bound-options");
  w.deps.sharedProject = undefined;
  w.deps.projects = async () => ["bound", "a", "b", "c"].map((id, i) => ({ id, name: id, lastActivityAt: 10 - i }));
  w.deps.bindings = () => [{ centerId: "other", teamId: "other", projectId: "other", localProjectId: "bound" }];
  expect((await post(w, "in-peer", offerBody(markedCode()))).status).toBe(202);
  expect((w.asks[0]!.options[0] as { buttons: { label: string }[] }).buttons.map(b => b.label))
    .toEqual(["加入并绑到 a", "加入并绑到 b", "加入并绑到 c", "不加入"]);
  w.deps.bindings = () => { throw new Error(MARK); };
  const response = await post(w, "in-peer", offerBody(markedCode()));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "local_project_state_unavailable" });
  expect(logs.join("\n")).not.toContain(MARK);
});

describe("shared-project hint only from an exact binding (JN4H)", () => {
  const labels = (w: World) => (w.asks[0]!.options[0] as { buttons: { label: string }[] }).buttons.map(b => b.label);
  const projects = async () => ["bound", "project-a", "x"].map((id, i) => ({ id, name: id, lastActivityAt: 10 - i }));

  test("explicit project with only another project bound at the same center: no 同名, no hint, that binding stays excluded", async () => {
    const w = world("peer-jn4h-other"), body = offerBody(markedCode());
    w.deps.projects = projects;
    w.deps.sharedProject = () => ({ teamId: "team-a", projectId: "project-a" });
    w.deps.bindings = () => [{ centerId: parseSharedLedgerJoinCode(body.code)!.centerId, teamId: "team-a", projectId: "other", localProjectId: "bound" }];
    expect((await post(w, "in-peer", body)).status).toBe(202);
    expect(w.asks[0]!.context).toContain("入组后才能确定团队 / 共享项目");
    expect(w.asks[0]!.context).not.toContain("根据已有绑定");
    expect(labels(w)).toEqual(["加入并绑到 project-a", "加入并绑到 x", "不加入"]);
    expect(readPendingOffer(w.dir, body.offerId)!.sharedProjectId).toBeUndefined();
  });

  test("explicit project with an exact center/team/project binding: hint, 同名 and the bound local project stays selectable", async () => {
    const w = world("peer-jn4h-same"), body = offerBody(markedCode());
    w.deps.projects = projects;
    w.deps.sharedProject = () => ({ teamId: "team-a", projectId: "project-a" });
    bindProjectA(w, body.code, "bound");
    expect((await post(w, "in-peer", body)).status).toBe(202);
    expect(w.asks[0]!.context).toContain("共享项目（根据已有绑定）：project-a");
    expect(labels(w)).toEqual(["加入并绑到 project-a（同名）", "加入并绑到 bound", "加入并绑到 x", "不加入"]);
  });

  test("explicit project under another team does not borrow the binding", async () => {
    const w = world("peer-jn4h-team"), body = offerBody(markedCode());
    w.deps.projects = projects;
    w.deps.sharedProject = () => ({ teamId: "team-b", projectId: "project-a" });
    bindProjectA(w, body.code, "bound");
    expect((await post(w, "in-peer", body)).status).toBe(202);
    expect(w.asks[0]!.context).not.toContain("根据已有绑定");
    expect(labels(w)).toEqual(["加入并绑到 project-a", "加入并绑到 x", "不加入"]);
  });

  test("old offer without project: two bindings at the center stay unknown; one binding keeps the original inference", async () => {
    const w = world("peer-jn4h-old"), body = offerBody(markedCode()), centerId = parseSharedLedgerJoinCode(body.code)!.centerId;
    w.deps.projects = projects;
    w.deps.sharedProject = undefined;
    w.deps.bindings = () => [{ centerId, teamId: "team-a", projectId: "project-a", localProjectId: "bound" },
      { centerId, teamId: "team-a", projectId: "other", localProjectId: "x" }];
    expect((await post(w, "in-peer", body)).status).toBe(202);
    expect(w.asks[0]!.context).toContain("入组后才能确定团队 / 共享项目");
    expect(labels(w)).toEqual(["加入并绑到 project-a", "不加入"]);
    const one = offerBody(markedCode());
    bindProjectA(w, one.code, "bound");
    expect((await post(w, "in-peer", one)).status).toBe(202);
    expect(w.asks[1]!.context).toContain("共享项目（根据已有绑定）：project-a");
  });
});
