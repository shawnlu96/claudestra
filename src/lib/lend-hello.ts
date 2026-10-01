/**
 * 出借方 B 的 hello（docs/design/remote-capacity.md §8.1）：调度服务按节奏向每个 A 报授权与容量，顺带协商协议版本（meta proto:<peer>）。
 * 发给谁：lend.json 里有生效授权的 peer，加上「最近一次成功的 hello 带着授权、且 ≤180 秒」的 peer（要把 grant:null 告诉它）；
 * peer 记录过不了 peerLendProblem、环境里有代理变量就不发（调用方筛）。什么时候发：本进程第一轮、正文哈希变了（含收回）当轮就发，
 * 其余按 A 回的 helloMs 保活（夹在 30–60 秒：A 降级要 ≤60 秒发现），失败第一次下个 pass 重试、之后 5 / 15 / 30 / 60 秒退避（变了不等退避）。
 * 授权在组包前现读（liveGrant），读完到发出之间没有 await：本轮开头的快照、别的 peer 拖掉的时间都可能已过了收回。
 * seq 存在 journal meta，跨重启只增不减：同一个 boot 里迟到的旧 hello 翻不回已收回的授权。发之前用 A 的解析器自检，过不了不发、原因给 doctor。
 * 结果：成功 → proto 2；404 / 403 messages_only（不讲 v2）→ proto 1；别的失败 → 这一轮按 proto 1 处理并立刻补一次 poll。tests/lend-hello.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { LendEntry } from "./lend-config.js";
import { WRITE_ROLE_OPEN } from "./lend-grant-rules.js";
import { liveGrant } from "./lend-grant.js";
import type { LendDeps } from "./lend-drive.js";
import { pausedUntil } from "./lend-health.js";
import { dailyUsed, LEND_FAMILY } from "./lend-inbox.js";
import { getMeta, openSlots, setMeta, type LendRow } from "./lend-journal.js";
import { LEND_OLD_PEER, lendRequest, type LendCall, type LendRes } from "./lend-remote.js";
import { HELLO_FRESH_MS, LEND_PROTO, parseV2Request, type HelloRequest } from "./lend-wire-v2.js";

/** 协议 v2 的出站与摘要端口（LoopDeps.v2）：不设 = 只讲 v1 */
export interface V2Port {
  call: LendCall<"hello" | "beat">;
  /** 本进程随机（base64url）：A 按 boot + seq 防回滚 */
  boot: string;
  /** worker 最近的输出（脱敏前的原文）与活动时刻；读不到 = null（lend-beat.ts 处理顺序固定） */
  excerpt?(row: LendRow): Promise<{ text: string; at: number } | null>;
}

/** 一轮 lend 循环里各步共享的出站状态（lend-loop.ts 建） */
export interface LendRound {
  /** true = 还在不联网的收回阶段：任何出站都不发 */
  offline: boolean;
  /** 这一轮出站失败过一次的 peer：本轮对它的其余出站全部跳过（跳过不算发过） */
  failed: Set<string>;
  /** 这一轮要立刻 poll 的 peer（启动、hello 刚失败、刚从 proto 2 掉回 1） */
  pollNow: Set<string>;
}

export interface HelloDeps extends Pick<LendDeps, "db" | "now" | "log" | "writeOpen" | "readLend" | "context"> { v2: V2Port }

export const newBoot = (): string => randomBytes(12).toString("base64url");
export const protoKey = (peer: string): string => `proto:${peer}`;
const helloKey = (peer: string): string => `hello:${peer}`;
const SEQ_KEY = "helloSeq";
const BACKOFF_MS = [0, 5_000, 15_000, 30_000, 60_000];
const KEEP_MS = { min: 30_000, max: 60_000, fallback: 60_000 };
/** 对方不讲 v2（404 / 403 messages_only）：隔这么久再问一次，它升级了就自动切回推送 */
const OLD_PEER_RETRY_MS = 60_000;
/** hello / beat 的这几种失败 = 对方不讲 v2：旧版没有这条路由（404），或 A 那边只许这个 peer 投消息（403 messages_only） */
export const notV2 = (r: LendRes<unknown>): boolean => !r.ok && (r.code === LEND_OLD_PEER || (r.status === 403 && r.code === "messages_only"));
const clamp = (v: number | null | undefined, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, v ?? dflt));

export interface HelloState {
  boot: string; at: number; hash: string; ok: boolean; okAt: number | null; grant: boolean; error: string | null; selfCheck: string | null;
  tries: number; nextAt: number; helloMs: number | null; beatMs: number | null;
}

/** journal meta 里的 JSON；没有或读坏了都当没有（hello 会重发一遍、重新记，坏值不能让整轮抛出去） */
export function metaJson<T>(db: Database, key: string): T | null {
  const raw = getMeta(db, key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; /* 见上：当没有 */ }
}

export const helloState = (db: Database, peer: string): HelloState | null => metaJson<HelloState>(db, helloKey(peer));

/** 协商出来的对方协议版本（W4 的 ask 转发也用）：没协商过 = 1 */
export const peerProto = (db: Database, peer: string): 1 | 2 => (getMeta(db, protoKey(peer)) === "2" ? 2 : 1);

/**
 * 续租走 beat、收回停单在 beat 里报：协商过 proto 2、最近一次 hello 没失败（404 / 403 / 超时之后这一段一律按 v1 逐单续租）。
 * 不看新鲜度：收回、说完 grant:null 之后不再 hello，但手上还有单时 A 照样认 beat。
 */
export const speaksV2 = (db: Database, peer: string): boolean => peerProto(db, peer) === 2 && helloState(db, peer)?.ok === true;

/** 轮询能降到兜底节奏的前提：speaksV2，而且最近一次成功的 hello 没过 180 秒（A 那边也还当它在线） */
export function v2Live(db: Database, peer: string, now: number): boolean {
  const s = helloState(db, peer);
  return speaksV2(db, peer) && s!.okAt !== null && now - s!.okAt <= HELLO_FRESH_MS;
}

/** 收回之后还欠一句 grant:null 的 peer：最近一次成功的 hello 带着授权、且没过 180 秒（过了 A 自己就按 0 槽算） */
export function owedPeers(db: Database, now: number): string[] {
  const rows = db.query("SELECT key, value FROM lend_meta WHERE key LIKE 'hello:%'").all() as { key: string; value: string }[];
  return rows.map((r) => r.key.slice("hello:".length)).filter((peer) => {
    const s = helloState(db, peer);
    return !!s?.grant && s.okAt !== null && now - s.okAt <= HELLO_FRESH_MS;
  });
}

/** hello 正文（不含 v / boot / seq）。没有生效授权 = grant:null、0 槽；WRITE_ROLE_OPEN 关着时 roles 不会含 write；claude 永远 0 槽；busy 含已接下没领的单 */
export function helloBody(db: Database, entry: LendEntry | undefined, now: number, writeOpen = WRITE_ROLE_OPEN): Omit<HelloRequest, "v" | "boot" | "seq"> {
  const grant = entry ? {
    until: Date.parse(entry.until ?? ""), roles: entry.roles.filter((r) => r !== "write" || writeOpen), repos: entry.repos, ordersPerDay: entry.ordersPerDay,
    ordersLeftToday: Math.max(0, entry.ordersPerDay - dailyUsed(db, entry.peer, now)),
  } : null;
  const total = entry ? entry.families[LEND_FAMILY] ?? 0 : 0;
  const busy = entry ? openSlots(db, entry.peer, LEND_FAMILY) : 0;
  const pause = pausedUntil(db, now);
  return { proto: LEND_PROTO, grant, slots: { codex: { total, busy: Math.min(busy, 100) }, claude: { total: 0, busy: 0 } },
    paused: pause === null ? null : { reason: "codex_quota", until: pause } };
}

const hashOf = (body: object): string => createHash("sha256").update(JSON.stringify(body)).digest("hex");
const save = (db: Database, peer: string, s: HelloState): void => setMeta(db, helloKey(peer), JSON.stringify(s));

/** 掉回 proto 1：当轮立刻 poll 一次（推送不会再来了） */
function setProto(db: Database, peer: string, proto: 1 | 2, round: LendRound): void {
  if (peerProto(db, peer) === 2 && proto === 1) round.pollNow.add(peer);
  setMeta(db, protoKey(peer), String(proto));
}

/** 对一个 peer：到点（或状态变了）就发一次 hello，按结果记协议版本与下次时刻。授权现读，读不到 / 失效 = grant:null */
export async function helloPeer(d: HelloDeps, peer: string, round: LendRound): Promise<void> {
  const g = await liveGrant({ peer, fp: null }, d);
  const entry = g.ok ? g.entry : undefined;
  const now = d.now();
  const st = helloState(d.db, peer);
  const body = helloBody(d.db, entry, now, d.writeOpen);
  const hash = hashOf(body);
  if (st && st.boot === d.v2.boot && st.hash === hash && now < st.nextAt) return;
  const seq = Number(getMeta(d.db, SEQ_KEY) ?? 0) + 1;
  const full = { v: 1, proto: body.proto, boot: d.v2.boot, seq, grant: body.grant, slots: body.slots, paused: body.paused };
  const base: HelloState = { ok: false, okAt: null, grant: false, error: null, selfCheck: null, tries: 0, helloMs: null, beatMs: null, ...st, boot: d.v2.boot, at: now, hash, nextAt: now };
  const check = parseV2Request("hello", full);
  if (!check.ok) {
    d.log(`给 ${peer} 的 hello 自检没过，不发：${check.error}`);
    return save(d.db, peer, { ...base, ok: false, error: "自检没过", selfCheck: check.error, nextAt: now + KEEP_MS.fallback });
  }
  setMeta(d.db, SEQ_KEY, String(seq)); // 先占号再发：发出去的每个 seq 都比之前的大，进程在中间退出也不会重用
  const { v: _v, ...send } = full;
  const r = await lendRequest(d.v2.call, peer, "hello", send);
  const at = d.now();
  if (r.ok) {
    setProto(d.db, peer, r.value.proto >= LEND_PROTO ? 2 : 1, round);
    const keep = clamp(r.value.helloMs, KEEP_MS.min, KEEP_MS.max, KEEP_MS.fallback);
    return save(d.db, peer, { ...base, ok: true, okAt: at, grant: body.grant !== null, error: null, selfCheck: null, tries: 0, helloMs: r.value.helloMs,
      beatMs: r.value.beatMs, nextAt: at + keep });
  }
  if (notV2(r)) {
    setProto(d.db, peer, 1, round);
    return save(d.db, peer, { ...base, ok: false, error: r.code, selfCheck: null, tries: 0, nextAt: at + OLD_PEER_RETRY_MS });
  }
  const tries = (st && !st.ok ? st.tries : 0) + 1;
  d.log(`给 ${peer} 的 hello 没成（${r.code}），这一轮按 v1 轮询：${r.error}`);
  round.pollNow.add(peer);
  save(d.db, peer, { ...base, ok: false, error: `${r.code} ${r.error}`.slice(0, 200), selfCheck: null, tries, nextAt: at + BACKOFF_MS[Math.min(tries, BACKOFF_MS.length) - 1] });
}

/** 这一轮要 hello 的 peer：有生效授权的，加欠一句 grant:null 的（正文里的授权由 helloPeer 发前现读） */
export function helloTargets(db: Database, entries: readonly LendEntry[], now: number): string[] {
  return [...new Set([...entries.map((e) => e.peer), ...owedPeers(db, now)])];
}

/** doctor 用：对方协议、最近一次 hello（时刻或失败原因）、自检错误 */
export function helloView(db: Database, peer: string): { proto: string; hello: string | null; selfCheck: string | null; beatMs: number | null } {
  const s = helloState(db, peer);
  const proto = getMeta(db, protoKey(peer));
  return { proto: proto === "2" ? "v2" : proto === "1" ? "v1" : "未协商", selfCheck: s?.selfCheck ?? null, beatMs: s?.beatMs ?? null,
    hello: !s ? null : s.ok ? `成功 ${new Date(s.okAt!).toISOString().slice(11, 19)}` : `失败（${s.error ?? "?"}）${new Date(s.at).toISOString().slice(11, 19)}` };
}
