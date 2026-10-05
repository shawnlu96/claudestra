/**
 * 同端点直连 vs 中继的测量基线 harness（方法见 docs/design/relay-direct-baseline.md）。
 * 只做四件事：注入的只读请求 port 驱动采集、按 matched key 配对、分位数汇总、私密 manifest + 匿名公开汇总。
 * 这里不读任何生产配置 / 令牌、不签名：真实 peer 的 port 由 PM 在本地用现成 peerFetch / E2E client 包好再注入，
 * 所以 port 接口只有 GET，没有 method / body——写请求从类型上就发不出去。
 * 直接运行（loopback 子命令）只测隔离回环 fixture，产物标 source=loopback-fixture，不能当生产读数。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const PHASES = ["start", "hello", "send", "headers", "verified"] as const;
type Phase = (typeof PHASES)[number];
type PathKind = "direct" | "relay";
type Session = "handshake" | "reused";
export type ClockUnit = "ms" | "us" | "ns";
/** 外部读样本每轮上限：只量延迟，不做 bulk 压测 */
export const ROUND_MAX = 20;

/** 能拿来比的前提：同 responder、同端点、同 principal、同响应版本 / 压缩形态 / 字节与正文哈希 */
interface MatchKey {
  responder: string;
  endpoint: string;
  principal: string;
  responseVersion: string;
  encoding: string;
  bytes: number;
  bodyHash: string;
}

export interface Sample extends MatchKey {
  path: PathKind;
  session: Session;
  round: number;
  /** 0 = 传输层失败（超时 / 断连），没有 HTTP 状态 */
  status: number;
  shapeOk: boolean;
  verifyOk: boolean;
  unit: ClockUnit;
  /** 单调时钟读数（同一 unit），不是墙钟 */
  marks: Partial<Record<Phase, number>>;
  /** CLI / 进程启动耗时，独列，不并入任何 RTT */
  cliStartup?: number;
}

export type ExcludeReason = "bad_sample" | "phase_order" | "transport" | "status" | "shape" | "verify";

/** 各段时长（ms）：connect 只有握手样本且 port 报了 hello 才有 */
interface PhaseDurations {
  connect?: number;
  ttfb: number;
  body: number;
  total: number;
}
const DURATION_KEYS = ["connect", "ttfb", "body", "total"] as const;

const UNIT_DIV: Record<ClockUnit, number> = { ms: 1, us: 1_000, ns: 1_000_000 };

export function toMs(v: number, unit: ClockUnit): number {
  const d = UNIT_DIV[unit];
  if (!d) throw new Error(`未知时钟单位: ${String(unit)}`);
  return v / d;
}

/** 样本能不能进 RTT：失败类单列，绝不混进分位数 */
export function classify(s: Sample): { ok: true; d: PhaseDurations } | { ok: false; reason: ExcludeReason } {
  const m = s.marks ?? {};
  const need = [m.start, m.send, m.headers, m.verified];
  if (!UNIT_DIV[s.unit] || !(s.session === "handshake" || s.session === "reused")) return { ok: false, reason: "bad_sample" };
  if (s.status === 0) return { ok: false, reason: "transport" };
  if (need.some((v) => typeof v !== "number" || !Number.isFinite(v)) || (m.hello !== undefined && !Number.isFinite(m.hello))) {
    return { ok: false, reason: "bad_sample" };
  }
  if (s.status < 200 || s.status > 299) return { ok: false, reason: "status" };
  if (!s.shapeOk) return { ok: false, reason: "shape" };
  if (!s.verifyOk) return { ok: false, reason: "verify" };
  const seq = PHASES.map((p) => m[p]).filter((v): v is number => v !== undefined);
  if (seq.some((v, i) => i > 0 && v < seq[i - 1]!)) return { ok: false, reason: "phase_order" };
  const ms = (a: number, b: number) => toMs(b - a, s.unit);
  const d: PhaseDurations = { ttfb: ms(m.send!, m.headers!), body: ms(m.headers!, m.verified!), total: ms(m.start!, m.verified!) };
  if (s.session === "handshake" && m.hello !== undefined) d.connect = ms(m.start!, m.hello);
  return { ok: true, d };
}

export interface Stat {
  n: number;
  p50: number | null;
  p95: number | null;
  unit: "ms";
}

/** 最近秩分位数（不插值）：p 取 ceil(p·n) 那个样本，样本少时也是真实读数 */
export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

export function stat(values: number[]): Stat {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  const r = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
  return { n: v.length, p50: r(quantile(v, 0.5)), p95: r(quantile(v, 0.95)), unit: "ms" };
}

const keyOf = (s: MatchKey) => JSON.stringify([s.responder, s.endpoint, s.principal, s.responseVersion, s.encoding, s.bytes, s.bodyHash]);
const baseOf = (s: MatchKey) => JSON.stringify([s.responder, s.endpoint, s.principal]);

type SideStats = Record<(typeof DURATION_KEYS)[number] | "cliStartup", Stat>;
interface MatchedGroup {
  key: MatchKey;
  session: Session;
  status: "matched" | "unavailable";
  /** unavailable 的原因：某一侧没有有效样本；body_mismatch = 同 responder/端点/principal 但两侧响应版本、压缩或正文不同 */
  reason?: "no_direct" | "no_relay" | "body_mismatch";
  direct: SideStats;
  relay: SideStats;
}

function sideStats(rows: { s: Sample; d: PhaseDurations }[]): SideStats {
  const pick = (k: (typeof DURATION_KEYS)[number]) => stat(rows.map((r) => r.d[k]).filter((v): v is number => v !== undefined));
  const cli = rows.map((r) => (r.s.cliStartup === undefined ? NaN : toMs(r.s.cliStartup, r.s.unit)));
  return { connect: pick("connect"), ttfb: pick("ttfb"), body: pick("body"), total: pick("total"), cliStartup: stat(cli) };
}

export interface BaselineSummary {
  date: string;
  source: string;
  units: "ms";
  quantile: "nearest-rank";
  samples: number;
  excluded: Partial<Record<ExcludeReason, number>>;
  groups: MatchedGroup[];
}

/** 只在完全相同的 MatchKey + 会话形态里比较直连与中继；不同 responder 永远各成一组、不互比 */
export function summarize(samples: Sample[], meta: { date: string; source: string }): BaselineSummary {
  if (!meta.date || !meta.source) throw new Error("汇总必须带 date 与 source");
  const excluded: Partial<Record<ExcludeReason, number>> = {};
  const buckets = new Map<string, { key: MatchKey; session: Session; direct: { s: Sample; d: PhaseDurations }[]; relay: { s: Sample; d: PhaseDurations }[] }>();
  for (const s of samples) {
    const c = classify(s);
    if (!c.ok) {
      excluded[c.reason] = (excluded[c.reason] ?? 0) + 1;
      continue;
    }
    const id = `${keyOf(s)}|${s.session}`;
    let b = buckets.get(id);
    if (!b) buckets.set(id, (b = { key: pickKey(s), session: s.session, direct: [], relay: [] }));
    b[s.path].push({ s, d: c.d });
  }
  const all = [...buckets.values()];
  const groups = all.map((b): MatchedGroup => {
    const g: MatchedGroup = { key: b.key, session: b.session, status: "matched", direct: sideStats(b.direct), relay: sideStats(b.relay) };
    if (b.direct.length && b.relay.length) return g;
    const missing: PathKind = b.direct.length ? "relay" : "direct";
    const sibling = all.some((o) => o !== b && o.session === b.session && baseOf(o.key) === baseOf(b.key) && o[missing].length > 0);
    return { ...g, status: "unavailable", reason: sibling ? "body_mismatch" : missing === "relay" ? "no_relay" : "no_direct" };
  });
  return { date: meta.date, source: meta.source, units: "ms", quantile: "nearest-rank", samples: samples.length, excluded, groups };
}

function pickKey(s: MatchKey): MatchKey {
  const { responder, endpoint, principal, responseVersion, encoding, bytes, bodyHash } = s;
  return { responder, endpoint, principal, responseVersion, encoding, bytes, bodyHash };
}

// ───────────────────────── 采集 ─────────────────────────

interface PortResponse {
  status: number;
  headers: Record<string, string>;
  /** 头到了就返回；正文另取，headers→verified 才量得出来 */
  readBody(): Promise<Uint8Array>;
  /** port 确知连接是新握手还是复用时填；不填按「本次采集每个 port 的第一条 = handshake」 */
  session?: Session;
}

/** 只读请求 port：PM 本地注入（真实 peer 用现成 peerFetch/E2E client 包），harness 不碰凭据 */
export interface ReadonlyRequestPort {
  path: PathKind;
  /** PM 本地给的 responder 标识，公开汇总里只出匿名代号 */
  responder: string;
  principal: string;
  get(endpoint: string, hooks: { mark(phase: "hello" | "send"): void; signal: AbortSignal }): Promise<PortResponse>;
}

export interface Probe {
  endpoint: string;
  /** JSON shape 校验：不过的样本记 shape，不进 RTT */
  validate(json: unknown): boolean;
  /** 响应版本；缺省读 etag，再没有就是 unversioned */
  version?(json: unknown, headers: Record<string, string>): string;
}

export interface CollectOpts {
  rounds?: number;
  perRound?: number;
  now?: () => number;
  unit?: ClockUnit;
  timeoutMs?: number;
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** 严格串行（写请求不并行竞速这条同样适用于读：并发会互相污染 RTT）；每轮最多 ROUND_MAX 条 */
export async function collect(ports: ReadonlyRequestPort[], probes: Probe[], opts: CollectOpts = {}): Promise<Sample[]> {
  const rounds = opts.rounds ?? 1;
  const perRound = opts.perRound ?? ROUND_MAX;
  if (!probes.length) throw new Error("至少一个 probe");
  if (perRound < 1 || perRound > ROUND_MAX) throw new Error(`每轮样本数要在 1..${ROUND_MAX}`);
  const now = opts.now ?? (() => performance.now());
  const unit = opts.unit ?? "ms";
  const out: Sample[] = [];
  const seen = new Set<ReadonlyRequestPort>();
  for (let round = 1; round <= rounds; round++) {
    for (let i = 0; i < perRound; i++) {
      for (const port of ports) {
        const first = !seen.has(port);
        seen.add(port);
        out.push(await sampleOnce(port, probes[i % probes.length]!, { round, first, now, unit, timeoutMs: opts.timeoutMs ?? 15_000 }));
      }
    }
  }
  return out;
}

type OnceCtx = { round: number; first: boolean; now: () => number; unit: ClockUnit; timeoutMs: number };

async function sampleOnce(port: ReadonlyRequestPort, probe: Probe, c: OnceCtx): Promise<Sample> {
  const marks: Sample["marks"] = { start: c.now() };
  const base = { responder: port.responder, endpoint: probe.endpoint, principal: port.principal, path: port.path, round: c.round, unit: c.unit };
  const blank = { responseVersion: "unknown", encoding: "unknown", bytes: 0, bodyHash: "", shapeOk: false, verifyOk: false };
  let res: PortResponse;
  try {
    const mark = (p: "hello" | "send") => void (marks[p] ??= c.now());
    res = await port.get(probe.endpoint, { mark, signal: AbortSignal.timeout(c.timeoutMs) });
    marks.headers = c.now();
  } catch {
    // 传输失败本身就是要记的结果（status 0 → excluded.transport），错误原文可能带地址，不进记录
    return { ...base, ...blank, session: c.first ? "handshake" : "reused", status: 0, marks };
  }
  const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const session: Session = res.session ?? (c.first ? "handshake" : "reused");
  let body: Uint8Array = new Uint8Array();
  let json: unknown;
  let shapeOk = false;
  let verifyOk = false;
  try {
    body = await res.readBody();
    verifyOk = true;
    json = JSON.parse(new TextDecoder().decode(body));
    shapeOk = probe.validate(json) === true;
  } catch {
    // 读正文失败 → verifyOk=false；能读但不是 JSON → shapeOk=false。两者都按原因单列，不丢样本
  }
  marks.verified = c.now();
  if (marks.send === undefined) marks.send = marks.start; // port 不报 send 时退化为 start：ttfb 含建连，文档里写明
  const responseVersion = shapeOk ? (probe.version?.(json, headers) ?? headers.etag ?? "unversioned") : "invalid";
  const encoding = headers["content-encoding"] ?? "identity";
  return { ...base, session, status: res.status, shapeOk, verifyOk, responseVersion, encoding, bytes: body.byteLength, bodyHash: sha256(body), marks };
}

/** 把 fetch 形状的函数（如 peerFetch，签名头由调用方用现成 signedFor 产生）包成只读 port；harness 自己不生成任何凭据 */
export function fetchPort(
  o: Omit<ReadonlyRequestPort, "get"> & {
    baseUrl: string;
    fetchLike: (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
    headersFor?: (url: string) => Record<string, string>;
  },
): ReadonlyRequestPort {
  return {
    path: o.path, responder: o.responder, principal: o.principal,
    async get(endpoint, hooks) {
      const url = o.baseUrl.replace(/\/+$/, "") + endpoint;
      const headers = o.headersFor?.(url) ?? {};
      hooks.mark("send");
      const r = await o.fetchLike(url, { method: "GET", headers, signal: hooks.signal });
      return { status: r.status, headers: Object.fromEntries(r.headers), readBody: async () => new Uint8Array(await r.arrayBuffer()) };
    },
  };
}

// ───────────────────── desktop / iOS 启动 ─────────────────────

const STARTUP_PHASES = ["navigation", "api", "headers", "body", "firstUsableRender"] as const;
export interface StartupRecord {
  platform: "desktop" | "ios";
  temperature: "cold" | "warm";
  visibility: "foreground" | "background";
  /** device = 真机实测；pending = 等 PM/owner 测；simulated 一律拒收，不能当通过 */
  source: "device" | "pending" | "simulated";
  unit: ClockUnit;
  phases: Partial<Record<(typeof STARTUP_PHASES)[number], number>>;
  /** 测量时所见的网络切换（Wi-Fi↔蜂窝、Tailscale 起落……），只记录 */
  networkSwitch?: string;
}

export interface StartupGroup {
  platform: string;
  temperature: string;
  visibility: string;
  status: "measured" | "pending_pm_owner";
  phases: Record<string, Stat>;
}

const LABELS = { platform: ["desktop", "ios"], temperature: ["cold", "warm"], visibility: ["foreground", "background"] } as const;

/** 冷暖、前后台、平台各自成组；没有真机读数的组只列「PM/owner 待测」 */
export function summarizeStartup(records: StartupRecord[]): { groups: StartupGroup[]; rejected: number; networkSwitches: string[] } {
  const groups = new Map<string, { r: StartupRecord; device: StartupRecord[] }>();
  let rejected = 0;
  const networkSwitches: string[] = [];
  for (const r of records) {
    const labelsOk = (Object.keys(LABELS) as (keyof typeof LABELS)[]).every((k) => (LABELS[k] as readonly string[]).includes(r[k]));
    if (!labelsOk || !UNIT_DIV[r.unit] || (r.source !== "device" && r.source !== "pending")) {
      rejected++;
      continue;
    }
    if (r.networkSwitch) networkSwitches.push(redact(r.networkSwitch));
    const id = `${r.platform}|${r.temperature}|${r.visibility}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { r, device: [] }));
    if (r.source === "device") g.device.push(r);
  }
  const out = [...groups.values()].map(({ r, device }): StartupGroup => {
    const phases: Record<string, Stat> = {};
    for (const p of STARTUP_PHASES) {
      phases[p] = stat(device.map((d) => (d.phases[p] === undefined ? NaN : toMs(d.phases[p]!, d.unit))));
    }
    const status = device.length ? "measured" : "pending_pm_owner";
    return { platform: r.platform, temperature: r.temperature, visibility: r.visibility, status, phases };
  });
  return { groups: out, rejected, networkSwitches };
}

// ───────────────────── 私密 manifest / 匿名公开汇总 ─────────────────────

const SECRET_RES = [
  /(bearer\s+)[^\s"']+/gi,
  /((?:token|secret|key|sig|signature|password|cookie)=)[^&\s"']+/gi,
  /\b[A-Za-z0-9_\-+/]{32,}={0,2}/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
];

/** 公开文本里的凭据形状 / 长随机串 / IPv4 一律打码（可能误伤，宁可误伤） */
export function redact(text: string): string {
  return SECRET_RES.reduce((t, re) => t.replace(re, (_m, pre?: string) => `${typeof pre === "string" ? pre : ""}<redacted>`), text);
}

export interface PublicSummary extends Omit<BaselineSummary, "groups"> {
  manifestSha256: string;
  groups: (Omit<MatchedGroup, "key"> & { responder: string; endpoint: string; principal: string; bytes: number; encoding: string })[];
  startup?: ReturnType<typeof summarizeStartup>;
}

/** 匿名：responder / principal 换成按出现顺序的代号，端点去掉 query；版本与正文哈希不公开（可能指纹化对端） */
export function publicSummary(s: BaselineSummary, manifestSha256: string, startup?: StartupRecord[]): PublicSummary {
  const alias = (prefix: string) => {
    const m = new Map<string, string>();
    return (v: string) => m.get(v) ?? (m.set(v, `${prefix}${m.size + 1}`), m.get(v)!);
  };
  const resp = alias("R");
  const prin = alias("P");
  const groups = s.groups.map(({ key, ...g }) => ({
    ...g, responder: resp(key.responder), principal: prin(key.principal), endpoint: redact(key.endpoint.split("?")[0]!),
    bytes: key.bytes, encoding: key.encoding,
  }));
  return { ...s, groups, manifestSha256, ...(startup ? { startup: summarizeStartup(startup) } : {}) };
}

/** 私密记录必须落在仓库外：repo 路径可参数化，在其内就拒绝写 */
export function writePrivateManifest(dir: string, repoRoot: string, payload: unknown): { file: string; sha256: string } {
  const abs = resolve(dir);
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const rel = relative(real(repoRoot), real(existsSync(abs) ? abs : dirname(abs)));
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("私密 manifest 不能写进仓库目录");
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(payload);
  const hash = sha256(text);
  const file = join(abs, `relay-direct-${hash.slice(0, 12)}.json`);
  writeFileSync(file, text, { mode: 0o600 });
  return { file, sha256: hash };
}

/** 读回私密 manifest 并核哈希：被改过就拒绝出汇总 */
export function readPrivateManifest(file: string): { samples: Sample[]; meta: { date: string; source: string }; startup?: StartupRecord[] } {
  const text = readFileSync(file, "utf8");
  const want = /relay-direct-([0-9a-f]{12})\.json$/.exec(file)?.[1];
  if (!want || sha256(text).slice(0, 12) !== want) throw new Error("manifest 哈希对不上");
  return JSON.parse(text);
}

// ───────────────────── 回环 fixture（CLI） ─────────────────────

const FIXTURE_BODY = JSON.stringify({ ok: true, agents: [{ name: "fixture-a" }] });

/** 隔离回环：一个 responder + 一个只转发 GET 的回环「中继」，都在 127.0.0.1 随机端口，不碰任何真实服务 */
export async function runLoopback(opts: { perRound?: number; rounds?: number } = {}): Promise<{ samples: Sample[]; summary: BaselineSummary }> {
  const responder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(FIXTURE_BODY, { headers: { "content-type": "application/json", etag: "\"v1\"" } }) });
  const relay = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      const r = await fetch(`http://127.0.0.1:${responder.port}${u.pathname}${u.search}`);
      return new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers });
    },
  });
  try {
    const common = { responder: "loopback-responder", principal: "fixture-principal", fetchLike: fetch };
    const ports = [
      fetchPort({ ...common, path: "direct", baseUrl: `http://127.0.0.1:${responder.port}` }),
      fetchPort({ ...common, path: "relay", baseUrl: `http://127.0.0.1:${relay.port}` }),
    ];
    const probes: Probe[] = [{ endpoint: "/api/v1/agents", validate: (j) => Array.isArray((j as { agents?: unknown })?.agents) }];
    const samples = await collect(ports, probes, { perRound: opts.perRound ?? ROUND_MAX, rounds: opts.rounds ?? 1 });
    return { samples, summary: summarize(samples, { date: new Date().toISOString().slice(0, 10), source: "loopback-fixture" }) };
  } finally {
    responder.stop(true);
    relay.stop(true);
  }
}

function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const repo = argOf(argv, "--repo") ?? resolve(import.meta.dir, "..");
  if (argv[0] === "loopback") {
    const out = argOf(argv, "--out");
    if (!out) throw new Error("--out <仓库外的私密目录> 必填");
    const { samples, summary } = await runLoopback({ rounds: Number(argOf(argv, "--rounds") ?? 1) });
    const m = writePrivateManifest(out, repo, { samples, meta: { date: summary.date, source: summary.source } });
    console.log(JSON.stringify({ manifest: m.file, summary: publicSummary(summary, m.sha256) }, null, 2));
    return 0;
  }
  if (argv[0] === "summarize" && argv[1]) {
    const { samples, meta, startup } = readPrivateManifest(argv[1]);
    const sha = sha256(readFileSync(argv[1], "utf8"));
    console.log(JSON.stringify(publicSummary(summarize(samples, meta), sha, startup), null, 2));
    return 0;
  }
  console.error("用法: bun --no-env-file tests/relay-direct-baseline.ts loopback --out <dir> [--repo <path>] [--rounds n] | summarize <manifest>");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
