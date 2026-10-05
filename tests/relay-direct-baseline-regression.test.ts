import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, summarize, publicSummary, fetchPort, writePrivateManifest, readPrivateManifest, classify, type Sample, type ReadonlyRequestPort } from "./relay-direct-baseline.ts";
const meta = { date: "2026-10-05", source: "https://synthetic.example.invalid Basic abc token=short" };
const sample = (path: "direct" | "relay"): Sample => ({
  path, responder: "r", principal: "p", endpoint: "/private-peer", responseVersion: "v", encoding: "identity", bytes: 2,
  bodyHash: "a".repeat(64), session: "reused", round: 1, status: 200, shapeOk: true, verifyOk: true, unit: "ms",
  marks: { start: 0, send: 1, headers: 2, verified: 3 },
});
const probe = { endpoint: "/", validate: () => true };
function port(path: "direct" | "relay", readBody = async () => new TextEncoder().encode("{}")): ReadonlyRequestPort {
  return { path, responder: "r", principal: "p", get: async () => ({ status: 200, headers: {}, readBody }) };
}
test("public-text: arbitrary local text never published", () => {
  const pub = JSON.stringify(publicSummary(summarize([sample("direct"), sample("relay")], meta), "f".repeat(64), [{
    platform: "ios", temperature: "cold", visibility: "foreground", source: "pending", unit: "ms", phases: {},
    networkSwitch: "synthetic.example.invalid Basic abc peer-short",
  }]));
  for (const text of ["synthetic.example.invalid", "Basic abc", "peer-short", "/private-peer"]) expect(pub).not.toContain(text);
});
test("manifest-path: dotted children and missing descendants through symlink stay private", () => {
  const root = mkdtempSync(join(tmpdir(), "rd1-path-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  mkdirSync(join(repo, "..private"));
  expect(() => writePrivateManifest(join(repo, "..private"), repo, {})).toThrow();
  const alias = join(root, "alias"); symlinkSync(repo, alias);
  expect(() => writePrivateManifest(join(alias, "missing", "nested"), repo, {})).toThrow();
  const m = writePrivateManifest(join(root, "outside", "nested"), repo, { samples: [], meta });
  expect(realpathSync(m.file).startsWith(realpathSync(repo) + "/")).toBe(false);
});
test("round-limit: aggregate bounded paired budget and finite integer inputs", async () => {
  const rows = await collect([port("direct"), port("relay")], [probe]);
  expect(rows).toHaveLength(20);
  for (const value of [NaN, Infinity, 0, -1, 1.5]) {
    await expect(collect([port("direct")], [probe], { rounds: value })).rejects.toThrow();
    await expect(collect([port("direct")], [probe], { perRound: value })).rejects.toThrow();
  }
  await expect(collect([port("direct"), port("relay")], [probe], { perRound: 3 })).rejects.toThrow();
});
test("session-label: failed attempt cannot imply reuse; unknown is unavailable", async () => {
  let calls = 0;
  const p = port("direct");
  p.get = async (_ep, hooks) => {
    if (++calls === 1) throw new Error("synthetic failure before hello");
    hooks.mark("hello"); hooks.mark("send");
    return { status: 200, headers: {}, readBody: async () => new TextEncoder().encode("{}") };
  };
  const rows = await collect([p], [probe], { perRound: 2 });
  expect(rows.map(s => s.session)).toEqual(["unavailable", "unavailable"]);
  expect(summarize(rows, meta).groups.every(g => g.status === "unavailable")).toBe(true);
});
test("phase-boundary: buffered and streaming adapters expose only observed total", async () => {
  for (const buffered of [false, true]) {
    let time = 0;
    const p = fetchPort({ path: buffered ? "relay" : "direct", responder: "r", principal: "p", baseUrl: "http://synthetic.invalid",
      fetchLike: async () => {
        time += buffered ? 110 : 10;
        const r = new Response("{}");
        Object.defineProperty(r, "arrayBuffer", { value: async () => {
          if (!buffered) time += 100; return new TextEncoder().encode("{}").buffer;
        } });
        return r;
      },
    });
    const rows = await collect([p], [probe], { perRound: 1, now: () => time });
    const g = summarize(rows, meta).groups[0]!;
    expect(g[buffered ? "relay" : "direct"].total.p50).toBe(110);
    expect(g[buffered ? "relay" : "direct"].ttfb.n).toBe(0);
    expect(g[buffered ? "relay" : "direct"].body.n).toBe(0);
    expect(rows[0]!.marks.send).toBeUndefined();
    expect(rows[0]!.marks.headers).toBeUndefined();
  }
});
test("verify-reason: real collect to summarize body failure", async () => {
  const rows = await collect([port("direct", async () => { throw new Error("synthetic verify"); })], [probe], { perRound: 1 });
  expect(summarize(rows, meta).excluded).toEqual({ verify: 1 });
});
test("sample-schema: malformed imports and summaries cannot match or crash", () => {
  for (const patch of [
    { status: undefined }, { status: "200" }, { path: "unknown" }, { responder: undefined, principal: undefined },
    { round: 1.5 }, { bodyHash: "not-a-hash" }, { shapeOk: "true" }, { bytes: -1 }, { marks: { start: 0, verified: Infinity } },
  ]) {
    const rows = [Object.assign(sample("direct"), patch), Object.assign(sample("relay"), patch)] as Sample[];
    expect(classify(rows[0]!)).toEqual({ ok: false, reason: "bad_sample" });
    expect(summarize(rows, meta)).toMatchObject({ groups: [], excluded: { bad_sample: 2 } });
    const root = mkdtempSync(join(tmpdir(), "rd1-schema-"));
    const repo = join(root, "repo"); mkdirSync(repo);
    const m = writePrivateManifest(join(root, "private"), repo, { samples: rows, meta });
    expect(() => readPrivateManifest(m.file)).toThrow();
  }
  expect(classify(null as unknown as Sample)).toEqual({ ok: false, reason: "bad_sample" });
});

test("manifest-path: missing ancestors resolve an existing repository alias", () => {
  const root = mkdtempSync(join(tmpdir(), "rd1-alias-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const alias = join(root, "alias"); symlinkSync(repo, alias);
  expect(() => writePrivateManifest(join(alias, "missing", "nested"), repo, {})).toThrow();
});
test("phase-boundary: client observations preserve real stages and session state", async () => {
  let time = 0;
  const p = port("direct");
  p.get = async (_ep, hooks) => {
    time = 3; hooks.mark("hello"); time = 4; hooks.mark("send"); time = 14; hooks.mark("headers");
    return { status: 200, headers: {}, session: "handshake", readBody: async () => { time = 114; return new TextEncoder().encode("{}"); } };
  };
  const rows = await collect([p], [probe], { perRound: 1, now: () => time });
  expect(classify(rows[0]!)).toEqual({ ok: true, d: { connect: 3, ttfb: 10, body: 100, total: 114 } });
  time = 0;
  p.get = async (_ep, hooks) => {
    time = 1; hooks.mark("send"); time = 11; hooks.mark("headers");
    return { status: 200, headers: {}, session: "reused", readBody: async () => { time = 111; return new TextEncoder().encode("{}"); } };
  };
  const reused = await collect([p], [probe], { perRound: 1, now: () => time });
  expect(reused[0]!.session).toBe("reused");
  expect(classify(reused[0]!)).toEqual({ ok: true, d: { ttfb: 10, body: 100, total: 111 } });
});
