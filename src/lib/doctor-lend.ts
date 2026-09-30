/**
 * doctor 的出借 / 借入一行（lend.json，lib/lend-config.ts）：开没开、对谁、上限多少；文件无效时报 fail（此时实际按「关」处理）。
 * 另一行「出借循环」读 lend journal（lib/lend-journal.ts）：scheduler 服务最近有没有跑出借这一步、为什么没 poll、在跑几单、哪些单停下来保留了现场。
 */
import { existsSync } from "node:fs";
import type { Check } from "./doctor.js";
import { LEND_PATH, readLend, type LendEntry } from "./lend-config.js";
import { effectiveLend, readLendContext, type LendContact } from "./lend-policy.js";
import type { ProjectDef } from "./projects.js";

const lendLine = (e: LendEntry): string => {
  const fam = Object.entries(e.families).filter(([, n]) => n! > 0).map(([f, n]) => `${f} ${n}`).join(" / ");
  const confirm = e.confirm === "auto" ? "自动接单" : "逐单确认";
  return `${e.peer}（${fam}，每天 ${e.quota.ordersPerDay} 单，${confirm}${e.until ? `，到 ${e.until.slice(0, 16)}` : ""}）`;
};

export async function checkLend(path = LEND_PATH, ctx?: { contacts: LendContact[]; projects: ProjectDef[] }, now = Date.now()): Promise<Check[]> {
  const base = { group: "Peer", name: "出借 / 借入" };
  const read = await readLend(path);
  if (read.status === "invalid") {
    return [{ ...base, status: "fail", detail: `lend.json 无效，已按「关」处理（不出借、不借入）：${read.error}`,
      fix: `修好或删掉 ${path}，再用 manager lend set / borrow set 重写` }];
  }
  const { contacts, projects } = ctx ?? await readLendContext();
  const eff = effectiveLend(read, contacts, projects, now);
  const lend = eff.lending ? `出借：开，${eff.lend.map(lendLine).join("；")}` : read.file.enabled ? "出借：总开关开，但没有仍有效的条目" : "出借：关";
  const borrow = eff.borrow.length ? `借入：${eff.borrow.map((e) => `${e.peer}（${e.projects.join(",")}，最多 ${e.maxOpen} 单在跑）`).join("；")}` : "借入：无";
  const detail = `${lend}；${borrow}`;
  if (!eff.dropped.length) return [{ ...base, status: "ok", detail }];
  return [{ ...base, status: "warn", detail: `${detail}。已失效：${eff.dropped.join("；")}`, fix: "manager lend status / borrow status 查看；重新 set 或 off 掉失效的条目" }];
}

/** 出借开着却这么久没见到一轮 = 第四服务没装、没在跑或卡住了 */
const STALE_TICK_MS = 3 * 60_000;

export async function checkLendLoop(lendPath = LEND_PATH, journalPath?: string, now = Date.now()): Promise<Check[]> {
  const base = { group: "Peer", name: "出借循环" };
  const { LEND_JOURNAL_PATH, getMeta, liveOrders, openLendJournal } = await import("./lend-journal.js");
  const read = await readLend(lendPath);
  const on = read.status === "ok" && read.file.enabled;
  const path = journalPath ?? LEND_JOURNAL_PATH;
  if (!existsSync(path)) {
    return on ? [{ ...base, status: "warn", detail: "出借开着，但 scheduler 服务还没跑过出借这一步", fix: "确认第四服务在跑：manager doctor 的 launchd daemon 组里 scheduler 一行" }]
      : [{ ...base, status: "ok", detail: "没在出借" }];
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
      else parts.push(`${peer} 最近 poll ${p.lastPollAt ? new Date(p.lastPollAt).toISOString().slice(11, 19) : "未到点"}${p.lastError ? `（失败：${p.lastError}）` : ""}`);
    }
    if (kept.length) warns.push(`停下的单：${kept.map((k) => `${k.orderId}（${(k.reason ?? "").slice(0, 80)}）`).join("；")}`);
    const detail = [...parts, ...warns].join("；");
    return [warns.length ? { ...base, status: "warn", detail, fix: "manager lend status 看声明；停下保留现场的单在 ~/.claude-orchestrator/lend/work 下，核对后可手动删" }
      : { ...base, status: "ok", detail }];
  } finally { db.close(); }
}
