/**
 * 额度闸对 owner 的两条通知（进闸一条、出闸一条）与给 agent 的续跑话术。纯函数，单测 tests/quota-wall.test.ts。
 * 闸内不再逐个 agent 报错：这两条就是全部。
 */
import { t } from "./i18n.js";
import type { Wall, WallExitVia } from "./quota-wall.js";

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** 时长 → 「3 小时 12 分」/「45 分钟」 */
function fmtSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  if (!h) return t(`${min} 分钟`, `${min} min`);
  return t(`${h} 小时${min % 60 ? ` ${min % 60} 分` : ""}`, `${h} h${min % 60 ? ` ${min % 60} min` : ""}`);
}

function kindLabel(w: Wall): string {
  if (w.kind === "weekly") return t("周额度", "weekly limit");
  if (w.kind === "session") return t("5 小时额度", "session limit");
  return t("订阅额度", "usage limit");
}

function resetLine(w: Wall, now: number): string {
  if (w.resetsAt === null) {
    return t("重置时间：没认出来（出闸靠用卡回显 / 用量探测 / quota-wall clear）", "Resets: unknown (exit via reset card / usage probe / quota-wall clear)");
  }
  const when = w.resetsText ?? new Date(w.resetsAt).toLocaleString();
  const span = fmtSpan(w.resetsAt - now);
  return t(`重置：${when}（约 ${span}后）`, `Resets: ${when} (in about ${span})`);
}

export interface WallNoticeCtx {
  now: number;
  /** 押在队里、等出闸补投的消息条数 */
  queued: number;
  /** T2b-2 用量数据里此刻能用的重置卡张数；拿不到 = null */
  credits: number | null;
}

function agentsLine(w: Wall): string {
  const agents = Object.values(w.hits).map((h) => h.agent);
  const more = agents.length > 8 ? " …" : "";
  if (!agents.length) return t("撞墙的 agent 0 个", "0 agents hit it");
  return t(`撞墙的 agent ${agents.length} 个：${agents.slice(0, 8).join("、")}${more}`, `${agents.length} agent(s) hit it: ${agents.slice(0, 8).join(", ")}${more}`);
}

/** 进闸通知（#control 一条；网页顶部横幅显示同样的要点） */
export function wallNotice(w: Wall, c: WallNoticeCtx): string {
  const k = kindLabel(w);
  const lines = [
    t(`⛔ Claude Code 账号撞到${k}了（本机所有 Claude Code agent 共用，Codex / Pi 不受影响）`,
      `⛔ The Claude Code account hit its ${k} (shared by every Claude Code agent here; Codex / Pi unaffected)`),
    `- ${resetLine(w, c.now)}`,
    `- ${agentsLine(w)}`,
    `- ${t(`排队中的 agent 消息 ${c.queued} 条，恢复后自动送达，不用手动催`,
      `${c.queued} agent message(s) queued; delivered automatically after recovery — no need to nudge`)}`,
  ];
  if (c.credits !== null && c.credits > 0) {
    lines.push(`- ${t(`有 ${c.credits} 张重置卡可用：在任一撞墙窗口里 /limit-reset（bridge 不会自动用卡）`,
      `${c.credits} reset card(s) available: run /limit-reset in any walled window (the bridge never uses one on its own)`)}`);
  }
  lines.push(`- ${t("你直接发的消息照常送达。恢复后 bridge 自动关菜单、补投、续跑",
    "Your own messages still go through. On recovery the bridge closes the menus, delivers the queue and resumes the agents")}`);
  return lines.join("\n");
}

const VIA: Record<WallExitVia, () => string> = {
  resets_at: () => t("到了重置时间", "reset time reached"),
  limits_reset: () => t("有窗口用了重置卡", "a reset card was used"),
  probe: () => t("用量接口显示已恢复", "the usage API shows capacity again"),
  usage_cache: () => t("状态栏用量显示已恢复", "the status-line usage shows capacity again"),
  cli: () => t("quota-wall clear 人工确认", "manually cleared (quota-wall clear)"),
};

/** 出闸通知：恢复做完后发 */
export function recoveredNotice(w: Wall): string {
  const r = w.recovery!;
  const via = VIA[w.exit!.via]();
  const span = fmtSpan(w.exit!.at - w.enteredAt);
  const running = r.running.length ? t(`（${r.running.length} 个已经自己在跑，没打扰）`, ` (${r.running.length} already running, left alone)`) : "";
  const lines = [
    t(`✅ 额度已恢复（${via}），闸开了 ${span}`, `✅ Usage restored (${via}); the wall lasted ${span}`),
    `- ${t(`关菜单 ${r.escSent.length} 个窗口；补投 ${r.flushed} 条消息；续跑 ${r.resumed.length} 个 agent`,
      `Closed ${r.escSent.length} menu(s); delivered ${r.flushed} queued message(s); resumed ${r.resumed.length} agent(s)`)}${running}`,
  ];
  if (r.manual.length) {
    lines.push(`- ${t(`这几个窗口的画面对不上已知菜单，没发键，需要手动看一眼：${r.manual.join("、")}`,
      `These windows didn't show a recognised menu, so no key was sent — please check them: ${r.manual.join(", ")}`)}`);
  }
  return lines.join("\n");
}

/** 出闸后发给中断的 agent（发之前已确认它主回合空闲；T13a 合并后改走 meta.waitForIdle） */
export function wallResumeText(hitAt: number, error: string): string {
  const e = error || "API Error";
  const why = error === "rate_limit" ? t("撞额度", "hit the usage limit") : t(`以 API 错误结束（${e}）`, `ended with an API error (${e})`);
  return t(
    `[额度恢复] 你 ${hhmm(hitAt)} 那一回合${why}中断了，现在额度已恢复。请从上一步接着做，不必复述已做的；如果确实没有未完的事，直接 end_turn。`,
    `[Usage restored] Your turn at ${hhmm(hitAt)} was cut off (${why}); capacity is back. Continue from where you stopped without recapping; if nothing is left, just end_turn.`,
  );
}
