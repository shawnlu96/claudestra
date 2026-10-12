/**
 * 巡检提醒升级的推送（dispatch-recovery-AUDESC1，判定在 lib/ledger-audit-escalate.ts）：ledger-audit-service.ts 推完 pending 后调一次，
 * 按 to（当班 PM）把 `ledger audit --json` 的 escalate 合成一条通知，投出或押后就 `--ack-escalate`，失败不 ack、下一轮再试。
 * 确认的 id 每个单独一个参数（AUDESC2，不拼逗号：卡号里可以有逗号、空格、引号）。投递失败按收件人去重：第一次失败记一条、恢复时记一条。
 * mode observe 的只打一行日志（条数和 key），不推、不 ack，同一批不重复打。bridge 不读策略文件：模式由 CLI 随条目给出。
 * 这一路出错只打日志、不抛：pending 那一路的推送和 ack 已经做完，不受影响。
 */
import type { AuditNoticeReceipt } from "./ledger-audit-failure.js";

export interface EscalateEntry {
  key: string;
  taskId: string | null;
  rule: string;
  notifiedAt: number;
  from: string;
  to: string;
  detail: string;
  mode: "on" | "observe";
}

export interface EscalateDeps {
  notify: (to: string, content: string) => Promise<AuditNoticeReceipt>;
  runManager: (...args: string[]) => Promise<any>;
}

const ESCALATE_TITLE = "调度助理 60 分钟没处理的巡检提醒";
const DETAIL_MAX = 120;
const id = (e: EscalateEntry) => `${e.key}@${e.notifiedAt}`;
const pad = (n: number) => String(n).padStart(2, "0");
const at = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const clip = (s: string) => ([...s].length > DETAIL_MAX ? `${[...s].slice(0, DETAIL_MAX).join("")}…` : s);

/** 每条一行：卡号、规则、首次推送时刻、detail 截 120 字 */
export function escalateNoticeText(list: readonly EscalateEntry[]): string {
  const from = [...new Set(list.map((e) => e.from))].join(", ");
  const lines = list.map((e) => `- ${e.taskId ?? "（无卡号）"} · ${e.rule} · 首次推送 ${at(e.notifiedAt)} · ${clip(e.detail)}`);
  return [`🔎 ${ESCALATE_TITLE}（推给 ${from} 后已超过 60 分钟仍开着，${list.length} 条）`, ...lines].join("\n");
}

function entries(raw: unknown): EscalateEntry[] {
  const list = (raw as { escalate?: unknown } | null)?.escalate;
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is EscalateEntry => !!e && typeof e === "object" && typeof e.key === "string" && !!e.key && typeof e.to === "string" && !!e.to &&
    typeof e.from === "string" && Number.isSafeInteger(e.notifiedAt) && (e.mode === "on" || e.mode === "observe"));
}

/**
 * `--ack-escalate` 的参数：第一个 id 是旗标的值，其余放在 `--` 之后当位置参数（-- 开头的 id 也不会被当成旗标）。
 * manager/ledger-audit-cmd.ts 的 ackEscalate 按同样的形状收。
 */
export function ackEscalateArgs(ids: readonly string[]): string[] {
  const [first = "", ...rest] = ids;
  return ["ledger", "audit", "--ack-escalate", first, ...(rest.length ? ["--", ...rest] : [])];
}

/** 推一次；抛错和 failed 回执都算失败，给出原因（回执本身不带原因） */
async function attempt(d: EscalateDeps, to: string, content: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await d.notify(to, content);
    return res.kind === "failed" ? { ok: false, reason: "收件人不在线或投递未被接受" } : { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message || String(e) };
  }
}

/** 造一个升级推送器（每个 ticker 一个，记着上次观察日志的那一批、和正在投递失败的收件人） */
export function ledgerAuditEscalator(d: EscalateDeps): (raw: unknown) => Promise<void> {
  let lastObserved = "";
  const failing = new Set<string>();
  return async (raw) => {
    try {
      const all = entries(raw);
      const observed = all.filter((e) => e.mode === "observe").map(id).sort();
      const sig = observed.join(",");
      if (observed.length && sig !== lastObserved) console.log(`🔎 台账巡检升级观察：${observed.length} 条该升级给 PM（未推）：${sig}`);
      lastObserved = sig;
      const byTo = new Map<string, EscalateEntry[]>();
      for (const e of all) if (e.mode === "on") byTo.set(e.to, [...(byTo.get(e.to) ?? []), e]);
      for (const [to, list] of byTo) {
        const res = await attempt(d, to, escalateNoticeText(list));
        if (!res.ok) {
          // 不 ack：下一轮 CLI 还会列出来。同一收件人连续失败只记第一次
          if (!failing.has(to)) console.error(`⚠️ 台账巡检升级投递失败（不确认，下一轮重推）：收件人 ${to}，${list.length} 条，原因：${res.reason}`);
          failing.add(to);
          continue;
        }
        if (failing.delete(to)) console.log(`🔎 台账巡检升级投递恢复：收件人 ${to}，${list.length} 条`);
        const a = await d.runManager(...ackEscalateArgs(list.map(id)));
        if (a?.ok !== true) console.error(`⚠️ 台账巡检升级 ack 失败（下一轮会重推）：${String(a?.error ?? "")}`);
        else console.log(`🔎 台账巡检：升级 ${list.length} 条给 ${to}`);
      }
    } catch (e) {
      console.error(`⚠️ 台账巡检升级出错：${(e as Error).message}`);
    }
  };
}
