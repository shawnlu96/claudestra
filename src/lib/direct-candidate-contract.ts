/**
 * RDC1 直连候选的纯合同与准入决策（RD2 的代码拆分；owner 定的顺序是先已有 LAN / HTTPS / Tailscale 直连，再 RTC）。
 * 这里只回答「给定这批不可信候选，哪条完整可核、可以选」，不发现候选、不注册、不改路由：
 *   - 本模块不 import 任何东西：URL / 主机归属走注入的只读 classifyUrl（接既有 canonical 谓词），签名事实走注入的
 *     verifyProof（接既有权威验签）；不查网卡 / DNS、不 fetch、不读环境 / 本机配置、不读时钟（now 由调用方给）。
 *   - 缺 port、缺证明、port 抛错或判决形状不对 → 该候选不可选；任何未知 / 失败都保留旧中继路径（relayFallback 恒为 true）。
 *   - mode off 不评估也不推荐；observe 只给结果与建议（advisoryOnly，建议不是授权）；on 也只输出决策数据，接线在 RD2。
 * 单测 tests/direct-candidate-contract.test.ts。
 */

/** 来源白名单，顺序即偏好（同等可核时 LAN 优先） */
const DIRECT_SOURCES = ["lan", "https", "tailscale"] as const;
export type DirectSource = (typeof DIRECT_SOURCES)[number];

/** 候选声明自己能承载什么：peer = /api/v1 peer 调用，tunnel = 本机 Web */
const DIRECT_CAPABILITIES = ["peer", "tunnel"] as const;
type DirectCapability = (typeof DIRECT_CAPABILITIES)[number];

type DirectMode = "off" | "observe" | "on";

export interface InstanceIdentity {
  /** 实例钥匙指纹（instance-key.ts keyFingerprint 的形状由签名 port 权威核对，这里只核是规整的非空串） */
  fp: string;
  iid: string;
}

/** 规范化后的候选事实（签名 port 看到的就是它的冻结副本，不含 proof） */
interface DirectCandidateFact {
  id: string;
  source: DirectSource;
  instance: InstanceIdentity;
  /** 规范化后的绝对 URL（WHATWG href） */
  url: string;
  issuedAt: number;
  expiresAt: number;
  /** 发布方最近一次核过可达的时间（ms） */
  verifiedAt: number;
  capabilities: DirectCapability[];
}

/** 调用方显式给的数量 / 时间预算；每项都必须是不超过 DIRECT_BUDGET_CEILING 的正整数（偏差可为 0） */
export interface DirectBudget {
  maxCandidates: number;
  maxTtlMs: number;
  maxVerifyAgeMs: number;
  maxSkewMs: number;
}

/** 预算的硬天花板：模块常量，不是机器级参数，不读配置 */
export const DIRECT_BUDGET_CEILING: Readonly<DirectBudget> = Object.freeze({
  maxCandidates: 16,
  maxTtlMs: 24 * 3_600_000,
  maxVerifyAgeMs: 3_600_000,
  maxSkewMs: 300_000,
});

export type UrlVerdict = { ok: true; source: DirectSource } | { ok: false; reason: string };
export type ProofVerdict = { ok: true; signer: InstanceIdentity } | { ok: false; reason: string };

/** 只读窄 port：都由调用方注入，缺了对应候选就不可选 */
export interface DirectPorts {
  /** 既有 canonical URL / 主机归属判断：这条 URL 属于哪种来源，或为什么不属于 */
  classifyUrl?: (url: string) => UrlVerdict;
  /** 既有权威验签：proof 是否为某实例对 fact 的签名，签名方是谁 */
  verifyProof?: (fact: Readonly<DirectCandidateFact>, proof: unknown) => ProofVerdict;
}

type CandidateReason =
  | "bad_shape" | "unknown_field" | "bad_id" | "bad_source" | "bad_instance" | "bad_url" | "bad_time" | "bad_capabilities"
  | "identity_mismatch" | "not_yet_valid" | "expired" | "ttl_too_long" | "bad_verified_at" | "verify_stale" | "capability_missing"
  | "url_port_missing" | "url_port_error" | "url_port_bad_verdict" | "url_rejected" | "source_mismatch"
  | "proof_port_missing" | "proof_missing" | "proof_port_error" | "proof_port_bad_verdict" | "proof_rejected" | "signer_mismatch";

export type CandidateResult =
  | { id: string; eligible: true; source: DirectSource; url: string }
  | { id: string | null; eligible: false; reason: CandidateReason; detail?: string };

type ListError = "bad_mode" | "bad_budget" | "bad_now" | "bad_expected" | "bad_need" | "not_array" | "empty" | "too_many" | "duplicate_id";

export interface DirectDecisionInput {
  mode: DirectMode;
  /** 想直连的对端：候选声明的实例与签名方都必须是它 */
  expected: InstanceIdentity;
  need: DirectCapability;
  /** 不可信输入 */
  candidates: unknown;
  /** 注入的当前时间（ms） */
  now: number;
  budget: DirectBudget;
}

export interface DirectDecision {
  mode: DirectMode;
  /** off / observe 恒为 relay；on 只有选出完整可核候选时为 direct */
  route: "relay" | "direct";
  pick: { id: string; source: DirectSource; url: string } | null;
  /** observe 下为 true：pick 只是建议，不是授权 */
  advisoryOnly: boolean;
  /** 旧中继路径始终保留 */
  relayFallback: true;
  listError: ListError | null;
  /** 与输入同序的逐条结论；整单被拒或 off 时为空 */
  results: CandidateResult[];
}

const CANDIDATE_KEYS = new Set(["id", "source", "instance", "url", "issuedAt", "expiresAt", "verifiedAt", "capabilities", "proof"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDENTITY_RE = /^[\x21-\x7e]{1,128}$/;
const MAX_URL = 2048;
const MAX_DETAIL = 200;

type Plain = Record<string, unknown>;

/** 数组里读不到自有数据值的位置（空洞、getter）：后续按形状不对处理，不执行访问器 */
const NOT_DATA: unique symbol = Symbol("not_data");

/**
 * 只认普通对象的自有数据属性：getter、原型链字段、类实例一律当形状不对（不触发 getter）。
 * 副本无原型、逐键 defineProperty，自有 __proto__ 键照常是一个（未知）字段；Proxy 的反射陷阱抛错同样当形状不对。
 */
function readPlain(v: unknown): Plain | null {
  if (typeof v !== "object" || v === null) return null;
  try {
    if (Array.isArray(v)) return null;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return null;
    const out: Plain = Object.create(null) as Plain;
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== "string") return null;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !("value" in d)) return null;
      Object.defineProperty(out, key, { value: d.value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 不可信数组的一次性快照：只经 length / 下标的自有数据描述符读，空洞与 getter 位置记为 NOT_DATA；
 * 长度超过 max 时不逐项读（返回 "too_many"）；不是数组或反射抛错（含已撤销的 Proxy）返回 null。
 */
function readArray(v: unknown, max: number): unknown[] | "too_many" | null {
  try {
    if (!Array.isArray(v)) return null;
    const len = Object.getOwnPropertyDescriptor(v, "length");
    if (!len || !("value" in len) || !Number.isSafeInteger(len.value) || len.value < 0) return null;
    if (len.value > max) return "too_many";
    const out: unknown[] = [];
    for (let i = 0; i < len.value; i++) {
      const d = Object.getOwnPropertyDescriptor(v, String(i));
      out.push(d && "value" in d ? d.value : NOT_DATA);
    }
    return out;
  } catch {
    return null;
  }
}

function readIdentity(v: unknown): InstanceIdentity | null {
  const o = readPlain(v);
  if (!o || Object.keys(o).length !== 2) return null;
  const { fp, iid } = o;
  return typeof fp === "string" && typeof iid === "string" && IDENTITY_RE.test(fp) && IDENTITY_RE.test(iid) ? { fp, iid } : null;
}

const sameIdentity = (a: InstanceIdentity, b: InstanceIdentity) => a.fp === b.fp && a.iid === b.iid;

/** 绝对 http(s) URL，无凭据、无片段；返回规范化 href。URL 解析是纯字符串运算，不解析主机名 */
function readUrl(v: unknown, source: DirectSource): string | null {
  if (typeof v !== "string" || v.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null; // 不是绝对 URL（相对路径、乱码）：形状不对，与其它字段错误同一种结论
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.hash || v.includes("#")) return null;
  if (source === "https" && u.protocol !== "https:") return null;
  return u.href;
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function readCapabilities(v: unknown): DirectCapability[] | null {
  const items = readArray(v, DIRECT_CAPABILITIES.length);
  if (!Array.isArray(items) || items.length === 0) return null;
  const out: DirectCapability[] = [];
  for (const c of items) {
    if (!(DIRECT_CAPABILITIES as readonly unknown[]).includes(c) || out.includes(c as DirectCapability)) return null;
    out.push(c as DirectCapability);
  }
  return out;
}

type Parsed = { ok: true; fact: DirectCandidateFact; proof: unknown } | { ok: false; reason: CandidateReason };

/** 逐字段核形状；任何多余字段（含 caller 自带的 trusted / verified 布尔）整条拒 */
function parseCandidate(o: Plain): Parsed {
  if (Object.keys(o).some((k) => !CANDIDATE_KEYS.has(k))) return { ok: false, reason: "unknown_field" };
  const { id, source, issuedAt, expiresAt, verifiedAt } = o;
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, reason: "bad_id" };
  if (!(DIRECT_SOURCES as readonly unknown[]).includes(source)) return { ok: false, reason: "bad_source" };
  const instance = readIdentity(o.instance);
  if (!instance) return { ok: false, reason: "bad_instance" };
  const url = readUrl(o.url, source as DirectSource);
  if (!url) return { ok: false, reason: "bad_url" };
  if (!isTime(issuedAt) || !isTime(expiresAt) || !isTime(verifiedAt) || expiresAt <= issuedAt) return { ok: false, reason: "bad_time" };
  const capabilities = readCapabilities(o.capabilities);
  if (!capabilities) return { ok: false, reason: "bad_capabilities" };
  const fact = { id, source: source as DirectSource, instance, url, issuedAt, expiresAt, verifiedAt, capabilities };
  return { ok: true, fact, proof: o.proof };
}

interface Ctx {
  expected: InstanceIdentity;
  need: DirectCapability;
  now: number;
  budget: DirectBudget;
  ports: DirectPorts;
}

/** 不靠 port 就能判的资格：身份、时间窗、能力 */
function localRefusal(f: DirectCandidateFact, c: Ctx): CandidateReason | null {
  const { now, budget: b } = c;
  if (!sameIdentity(f.instance, c.expected)) return "identity_mismatch";
  if (f.issuedAt > now + b.maxSkewMs) return "not_yet_valid";
  if (f.expiresAt <= now) return "expired";
  if (f.expiresAt - f.issuedAt > b.maxTtlMs) return "ttl_too_long";
  if (f.verifiedAt < f.issuedAt || f.verifiedAt > now + b.maxSkewMs) return "bad_verified_at";
  if (now - f.verifiedAt > b.maxVerifyAgeMs) return "verify_stale";
  if (!f.capabilities.includes(c.need)) return "capability_missing";
  return null;
}

type Refusal = { reason: CandidateReason; detail?: string };

const detailOf = (v: unknown) => (typeof v === "string" && v ? v.slice(0, MAX_DETAIL) : undefined);

/** port 的判决同样不可信：ok 必须恰为 true，失败必须带原因串 */
function readVerdict(v: unknown): { ok: true; o: Plain } | { ok: false; reason: unknown } | null {
  const o = readPlain(v);
  if (o?.ok === true) return { ok: true, o };
  if (o?.ok === false) return { ok: false, reason: o.reason };
  return null;
}

function checkUrl(f: DirectCandidateFact, port: DirectPorts["classifyUrl"]): Refusal | null {
  if (!port) return { reason: "url_port_missing" };
  let raw: unknown;
  try {
    raw = port(f.url);
  } catch {
    return { reason: "url_port_error" }; // validator 自己出错：不可核即不可选，旧中继照用
  }
  const v = readVerdict(raw);
  if (!v || (v.ok && !(DIRECT_SOURCES as readonly unknown[]).includes(v.o.source))) return { reason: "url_port_bad_verdict" };
  if (!v.ok) return { reason: "url_rejected", detail: detailOf(v.reason) };
  return v.o.source === f.source ? null : { reason: "source_mismatch" };
}

function freezeFact(f: DirectCandidateFact): Readonly<DirectCandidateFact> {
  return Object.freeze({ ...f, instance: Object.freeze({ ...f.instance }), capabilities: Object.freeze([...f.capabilities]) as DirectCapability[] });
}

function checkProof(f: DirectCandidateFact, proof: unknown, port: DirectPorts["verifyProof"]): Refusal | null {
  if (!port) return { reason: "proof_port_missing" };
  if (proof === undefined || proof === null || proof === "") return { reason: "proof_missing" };
  let raw: unknown;
  try {
    raw = port(freezeFact(f), proof);
  } catch {
    return { reason: "proof_port_error" }; // 验签方出错：没有证明成立的事实，不可选
  }
  const v = readVerdict(raw);
  const signer = v?.ok ? readIdentity(v.o.signer) : null;
  if (!v || (v.ok && !signer)) return { reason: "proof_port_bad_verdict" };
  if (!v.ok) return { reason: "proof_rejected", detail: detailOf(v.reason) };
  return sameIdentity(signer!, f.instance) ? null : { reason: "signer_mismatch" };
}

type Judged = { result: CandidateResult; verifiedAt: number };

/** o 是候选的一次性快照（readPlain 结果）；之后只读快照，不再碰原输入 */
function judge(o: Plain | null, c: Ctx): Judged {
  const refuse = (id: string | null, r: Refusal): Judged =>
    ({ result: { id, eligible: false, reason: r.reason, ...(r.detail === undefined ? {} : { detail: r.detail }) }, verifiedAt: 0 });
  if (!o) return refuse(null, { reason: "bad_shape" });
  const p = parseCandidate(o);
  const id = typeof o.id === "string" && ID_RE.test(o.id) ? o.id : null;
  if (!p.ok) return refuse(id, { reason: p.reason });
  const f = p.fact;
  const local = localRefusal(f, c);
  if (local) return refuse(f.id, { reason: local });
  const refused = checkUrl(f, c.ports.classifyUrl) ?? checkProof(f, p.proof, c.ports.verifyProof);
  if (refused) return refuse(f.id, refused);
  return { result: { id: f.id, eligible: true, source: f.source, url: f.url }, verifiedAt: f.verifiedAt };
}

/** 预算的无原型副本；之后只用副本 */
function validBudget(v: unknown): DirectBudget | null {
  const o = readPlain(v);
  if (!o) return null;
  const keys = Object.keys(DIRECT_BUDGET_CEILING) as (keyof DirectBudget)[];
  if (Object.keys(o).length !== keys.length) return null;
  const ok = keys.every((k) => {
    const n = o[k];
    const floor = k === "maxSkewMs" ? 0 : 1;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= floor && n <= DIRECT_BUDGET_CEILING[k];
  });
  return ok ? (o as unknown as DirectBudget) : null;
}

type Prepared = { ok: true; ctx: Ctx; items: (Plain | null)[] } | { ok: false; listError: ListError };

/**
 * 整单层面的拒绝：输入坏、空、超量、重复 id —— 这些情况下一个 port 都不调。
 * 通过时给出决策上下文与候选快照：预算 / 期望身份 / 列表 / 每条候选都只读一次，查重、评估、挑选共用这一份。
 */
function prepare(input: DirectDecisionInput, ports: DirectPorts): Prepared {
  const budget = validBudget(input.budget);
  if (!budget) return { ok: false, listError: "bad_budget" };
  const now = input.now;
  if (!isTime(now)) return { ok: false, listError: "bad_now" };
  const expected = readIdentity(input.expected);
  if (!expected) return { ok: false, listError: "bad_expected" };
  const need = input.need;
  if (!(DIRECT_CAPABILITIES as readonly unknown[]).includes(need)) return { ok: false, listError: "bad_need" };
  const list = readArray(input.candidates, budget.maxCandidates);
  if (list === null) return { ok: false, listError: "not_array" };
  if (list === "too_many") return { ok: false, listError: "too_many" };
  if (list.length === 0) return { ok: false, listError: "empty" };
  const items = list.map(readPlain);
  const seen = new Set<string>();
  for (const o of items) {
    const id = o?.id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) return { ok: false, listError: "duplicate_id" };
    seen.add(id);
  }
  const p = { classifyUrl: ports.classifyUrl, verifyProof: ports.verifyProof };
  return { ok: true, ctx: { expected, need, now, budget, ports: p }, items };
}

/** 同等可核时：来源偏好 → 验证时间新 → id 字典序小（不用 localeCompare，避免依赖运行环境的区域设置） */
function rank(a: { source: DirectSource; id: string; verifiedAt: number }, b: typeof a): number {
  const s = DIRECT_SOURCES.indexOf(a.source) - DIRECT_SOURCES.indexOf(b.source);
  if (s) return s;
  if (a.verifiedAt !== b.verifiedAt) return b.verifiedAt - a.verifiedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function choose(judged: Judged[]): DirectDecision["pick"] {
  const pool = judged.flatMap(({ result: r, verifiedAt }) => (r.eligible ? [{ id: r.id, source: r.source, url: r.url, verifiedAt }] : []));
  const best = pool.sort(rank)[0];
  return best ? { id: best.id, source: best.source, url: best.url } : null;
}

/**
 * 纯决策：同输入同输出。off（含未知模式）不评估；observe 评估但 route 恒为 relay、pick 只是建议；
 * on 只有完整可核候选时 route 才为 direct——仍只是数据，真正走不走、失败怎么退回中继由 RD2 决定。
 */
export function decideDirectRoute(input: DirectDecisionInput, ports: DirectPorts): DirectDecision {
  const base = { route: "relay" as const, pick: null, relayFallback: true as const, results: [] };
  const mode = input.mode;
  if (mode !== "off" && mode !== "observe" && mode !== "on") return { ...base, mode: "off", advisoryOnly: false, listError: "bad_mode" };
  if (mode === "off") return { ...base, mode, advisoryOnly: false, listError: null };
  const advisoryOnly = mode === "observe";
  const prep = prepare(input, ports);
  if (!prep.ok) return { ...base, mode, advisoryOnly, listError: prep.listError };
  const judged = prep.items.map((o) => judge(o, prep.ctx));
  const pick = choose(judged);
  return { ...base, mode, advisoryOnly, listError: null, results: judged.map((j) => j.result), pick, route: mode === "on" && pick ? "direct" : "relay" };
}
