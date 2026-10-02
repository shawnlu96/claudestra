/**
 * doctor 的出借 / 借入一行（lend.json，lib/lend-config.ts）：当前授权（对谁、名额、每天几单、到期时间和剩余）、对方协议版本；
 * 文件无效时报 fail（此时实际按「关」处理），暂停 / 过期 / 失效的授权列进 warn。
 * 另一行「出借循环」读 lend journal（lib/lend-journal.ts）：scheduler 服务最近有没有跑出借这一步、为什么没 poll、在跑几单、哪些单停下来保留了现场；
 * 协议 v2 起每个 peer 再列协议版本、最近一次 hello / beat、最近收到推送的时刻和当前轮询节奏，hello 自检没过、收到推送却没有同名授权列进 warn。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Check } from "./doctor.js";
import { LEND_PATH, readLend, type LendEntry } from "./lend-config.js";
import { effectiveLend, readLendContext, type LendContact } from "./lend-policy.js";
import type { ProjectDef } from "./projects.js";
import { readStoppedWorkSummary, stoppedWorkText } from "./lend-work-retention.js";

const leftOf = (until: string, now: number): string => {
  const h = Math.max(0, Math.floor((Date.parse(until) - now) / 3_600_000));
  return h >= 48 ? `${Math.floor(h / 24)} 天` : `${h} 小时`;
};

const lendLine = (e: LendEntry, now: number, proto: (peer: string) => string): string => {
  const fam = Object.entries(e.families).filter(([, n]) => n! > 0).map(([f, n]) => `${f} ${n}`).join(" / ");
  const until = e.until ?? "";
  return `${e.peer}（${fam}，每天 ${e.ordersPerDay} 单，授权到 ${until.slice(0, 16)}，还剩 ${leftOf(until, now)}，对方协议 ${proto(e.peer)}）`;
};

/** 对方协议版本：W3 起由 hello 协商、记进 journal meta proto:<peer>；没记过 = 只会 v1 轮询 */
async function peerProtos(journalPath?: string): Promise<(peer: string) => string> {
  const { LEND_JOURNAL_PATH, openLendJournal } = await import("./lend-journal.js");
  const path = journalPath ?? LEND_JOURNAL_PATH;
  const seen = new Map<string, string>();
  if (existsSync(path)) {
    const db = openLendJournal(path);
    try {
      const rows = db.query("SELECT key, value FROM lend_meta WHERE key LIKE 'proto:%'").all() as { key: string; value: string }[];
      for (const r of rows) seen.set(r.key.slice("proto:".length), `v${r.value}`);
    } finally { db.close(); }
  }
  return (peer) => seen.get(peer) ?? "v1（未协商）";
}

export async function checkLend(path = LEND_PATH, ctx?: { contacts: LendContact[]; projects: ProjectDef[] }, now = Date.now(), journalPath?: string): Promise<Check[]> {
  const base = { group: "Peer", name: "出借 / 借入" };
  const read = await readLend(path);
  if (read.status === "invalid") {
    return [{ ...base, status: "fail", detail: `lend.json 无效，已按「关」处理（不出借、不借入）：${read.error}`,
      fix: `修好或删掉 ${path}，再用 manager lend grant / borrow set 重写` }];
  }
  const { contacts, projects } = ctx ?? await readLendContext();
  const eff = effectiveLend(read, contacts, projects, now);
  const proto = await peerProtos(journalPath);
  const lend = eff.lending ? `出借：开，${eff.lend.map((e) => lendLine(e, now, proto)).join("；")}` : read.file.enabled ? "出借：总开关开，但没有仍有效的授权" : "出借：关";
  const borrow = eff.borrow.length ? `借入：${eff.borrow.map((e) => `${e.peer}（${e.projects.join(",")}，最多 ${e.maxOpen} 单在跑）`).join("；")}` : "借入：无";
  const detail = `${lend}；${borrow}`;
  if (!eff.dropped.length) return [{ ...base, status: "ok", detail }];
  return [{ ...base, status: "warn", detail: `${detail}。已失效：${eff.dropped.join("；")}`, fix: "manager lend status / borrow status 查看；出借用 lend grant 重新授权或 lend revoke 收回，借入重新 set 或 off" }];
}

/** 出借开着却这么久没见到一轮 = 第四服务没装、没在跑或卡住了 */
const STALE_TICK_MS = 3 * 60_000;
/** 这么久之内收到过的推送才拿来对授权名字 */
const PUSH_RECENT_MS = 86_400_000;
const hhmmss = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

type PeerStatus = import("./lend-loop.js").LendStatus["peers"][string];

/** 一个 peer 的 poll 与 v2 状态（没有 v2 字段的老摘要只报 poll） */
const peerLine = (peer: string, p: PeerStatus): string => `${peer} 最近 poll ${p.lastPollAt ? hhmmss(p.lastPollAt) : "未到点"}${p.lastError ? `（失败：${p.lastError}）` : ""}` +
  (p.proto === undefined ? "" : `，协议 ${p.proto}，hello ${p.hello ?? "没发过"}，beat ${p.beat ?? "没发过"}，推送 ${p.pushAt ? hhmmss(p.pushAt) : "没收到过"}` +
    `，轮询每 ${Math.round((p.pollMs ?? 0) / 1000)} 秒`);

/** 收到了推送、lend.json 却没有这个名字的授权：多半是两边记的 peer 名对不上 */
function pushWithoutGrant(db: import("bun:sqlite").Database, names: string[], now: number): string[] {
  const rows = db.query("SELECT key, value FROM lend_meta WHERE key LIKE 'pushAt:%'").all() as { key: string; value: string }[];
  return rows.filter((r) => now - Number(r.value) <= PUSH_RECENT_MS && !names.includes(r.key.slice("pushAt:".length))).map((r) => r.key.slice("pushAt:".length));
}

export async function checkLendLoop(lendPath = LEND_PATH, journalPath?: string, now = Date.now()): Promise<Check[]> {
  const base = { group: "Peer", name: "出借循环" };
  const { LEND_JOURNAL_PATH, getMeta, liveOrders, openLendJournal } = await import("./lend-journal.js");
  const read = await readLend(lendPath);
  const on = read.status === "ok" && read.file.enabled;
  const path = journalPath ?? LEND_JOURNAL_PATH;
  const retention = stoppedWorkText(readStoppedWorkSummary(path));
  if (!existsSync(path)) {
    return on ? [{ ...base, status: "warn", detail: `出借开着，但 scheduler 服务还没跑过出借这一步；${retention}`, fix: "确认第四服务在跑：manager doctor 的 launchd daemon 组里 scheduler 一行" }]
      : [{ ...base, status: "ok", detail: `没在出借；${retention}` }];
  }
  const db = openLendJournal(path);
  try {
    const live = liveOrders(db);
    const raw = getMeta(db, "status");
    const st = raw ? JSON.parse(raw) as import("./lend-loop.js").LendStatus : null;
    const kept = (db.query("SELECT orderId, reason FROM lend_orders WHERE state = 'stopped' AND updatedAt > ? ORDER BY updatedAt DESC LIMIT 5")
      .all(now - 7 * 86_400_000) as { orderId: string; reason: string | null }[]);
    const parts = [`在跑 ${live.length} 单${live.length ? `（${live.map((r) => `${r.peer}/${r.state}`).join("、")}）` : ""}`];
    const warns: string[] = [];
    if ((on || live.length) && (!st || now - st.at > STALE_TICK_MS)) warns.push(`scheduler 服务 ${st ? `${Math.round((now - st.at) / 60_000)} 分钟` : "从来"}没跑出借这一步（第四服务没在跑？）`);
    if (st?.blocked && on) warns.push(`不 poll：${st.blocked}`);
    for (const [peer, p] of Object.entries(st?.peers ?? {})) {
      if (p.problem) warns.push(`不向 ${peer} 借单：${p.problem}`);
      else parts.push(peerLine(peer, p));
      if (p.selfCheck) warns.push(`给 ${peer} 的 hello 自检没过、没发出去：${p.selfCheck}`);
    }
    for (const peer of pushWithoutGrant(db, read.file.lend.map((e) => e.peer), now)) warns.push(`收到 ${peer} 的推送，但 lend.json 里没有叫这个名字的授权（多半是名字对不上）`);
    if (kept.length) warns.push(`停下的单：${kept.map((k) => `${k.orderId}（${(k.reason ?? "").slice(0, 80)}）`).join("；")}`);
    const detail = [...parts, retention, ...warns].join("；");
    return [warns.length ? { ...base, status: "warn", detail, fix: `manager lend status 看声明；${join(dirname(path), "work")} 下的 stopped 副本保留 24 小时后自动清理` }
      : { ...base, status: "ok", detail }];
  } finally { db.close(); }
}
