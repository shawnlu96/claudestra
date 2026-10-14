/**
 * bridge 卡住 / 恢复的带外通知（docs/architecture/bridge-watchdog.md「带外通知」）：notify() 经 bridge 投递，
 * 要报的恰恰是 bridge 卡住，那条路不通。这里不经 bridge：有 Discord 配置就直接调 REST 往控制频道发，没有就发系统通知。
 * token 只从环境读，只进请求头；不进日志、命令参数和错误文本。每个卡住事件开始、恢复各发一条，由 bridge-watchdog.ts 调。
 * 网络、命令、环境都经 OobIo 注入，tests/bridge-watchdog-oob.test.ts。
 */
import { hostname } from "os";
import { t } from "./i18n.js";
import { execWithTimeout, readSideMode, type ExecResult, type SideMode } from "./bridge-watchdog-diag.js";

const OOB_CONFIG_KEY = "bridgeWatchdogOob";
const OOB_TIMEOUT_MS = 5_000;

export interface OobEvent {
  kind: "stuck" | "recovered";
  reason: "api" | "relay";
  /** 卡住前最后一次正常的时间 */
  lastOkAt: number | null;
  /** 这个卡住事件第一次被判定的时间 */
  startedAt: number;
  /** 看门狗（bridgeWatchdog）当前档位 */
  watchdogMode: string;
  /** 这次抓到的现场目录名；没抓 = null */
  diagDir: string | null;
}

export interface OobIo {
  mode(): SideMode;
  platform: string;
  /** DISCORD_BOT_TOKEN / CONTROL_CHANNEL_ID；每次现读环境 */
  discord(): { token: string; channelId: string };
  hostname(): string;
  fetch(url: string, init: RequestInit): Promise<{ ok: boolean; status: number }>;
  exec(cmd: string[], timeoutMs: number): Promise<ExecResult>;
  log(line: string): void;
}

const fmtTime = (at: number | null) => (at === null ? t("无记录", "never") : new Date(at).toISOString());

/** 机器名只取短名（第一个点之前），去掉字母数字、下划线、连字符以外的字符：主机全名不外发 */
function machineName(io: OobIo): string {
  return io.hostname().split(".")[0]!.replace(/[^\w-]/g, "") || "?";
}

/** 判定原因用固定措辞，不带探测的错误原文（里面可能有地址和端口） */
function reasonText(reason: OobEvent["reason"]): string {
  return reason === "api"
    ? t("本机接口连续无响应", "local API stopped responding")
    : t("中继长时间未连上且重连没有前进", "relay disconnected and reconnect is not progressing");
}

function oobText(ev: OobEvent, io: OobIo): string {
  const host = machineName(io);
  const diag = ev.diagDir ?? t("无", "none");
  if (ev.kind === "recovered") {
    return t(
      `✅ [${host}] bridge 恢复正常。卡住始于 ${fmtTime(ev.startedAt)}，原因：${reasonText(ev.reason)}；卡住前最后一次正常：${fmtTime(ev.lastOkAt)}；` +
        `看门狗档位：${ev.watchdogMode}；现场：${diag}`,
      `✅ [${host}] Bridge is healthy again. Stuck since ${fmtTime(ev.startedAt)}, reason: ${reasonText(ev.reason)}; last healthy before that: ${fmtTime(ev.lastOkAt)}; ` +
        `watchdog mode: ${ev.watchdogMode}; diagnostics: ${diag}`,
    );
  }
  return t(
    `🚨 [${host}] bridge 卡住。原因：${reasonText(ev.reason)}；最后一次正常：${fmtTime(ev.lastOkAt)}；看门狗档位：${ev.watchdogMode}；现场：${diag}`,
    `🚨 [${host}] Bridge is stuck. Reason: ${reasonText(ev.reason)}; last healthy: ${fmtTime(ev.lastOkAt)}; watchdog mode: ${ev.watchdogMode}; diagnostics: ${diag}`,
  );
}

/** 错误文本里万一带了 token（不该有）也抹掉再往外给 */
function scrub(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

async function viaDiscord(text: string, d: { token: string; channelId: string }, io: OobIo): Promise<string> {
  try {
    const res = await io.fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(d.channelId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${d.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(OOB_TIMEOUT_MS),
    });
    return res.ok ? "已发到控制频道（Discord REST）" : `Discord REST 失败（HTTP ${res.status}）`;
  } catch (e) {
    return `Discord REST 失败（${scrub((e as Error).message, d.token)}）`;
  }
}

/** 系统通知：正文走 argv 传给脚本，不拼进 AppleScript 源码；只发通知，不操作任何界面 */
async function viaSystem(text: string, io: OobIo): Promise<string> {
  if (io.platform !== "darwin") return "没有 Discord 配置，本平台没有系统通知，只记日志";
  const script = ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "Claudestra"', "-e", "end run"];
  const r = await io.exec(["osascript", ...script, text], OOB_TIMEOUT_MS);
  return r.ok ? "已发系统通知" : `系统通知失败（${r.error}）`;
}

/** 发一条带外通知。off 什么都不做；observe 只记本会发什么；失败只记日志，从不抛 */
export async function sendBridgeOob(ev: OobEvent, io: OobIo): Promise<void> {
  const mode = io.mode();
  if (mode === "off") return;
  let token = "";
  try {
    const d = io.discord();
    token = d.token;
    const text = oobText(ev, io);
    const hasDiscord = !!d.token && !!d.channelId;
    if (mode === "observe") {
      const route = hasDiscord ? "Discord REST → 控制频道" : io.platform === "darwin" ? "系统通知" : "只记日志";
      io.log(`🩺 带外通知[observe] 本会发（${route}）：${text}`);
      return;
    }
    const result = hasDiscord ? await viaDiscord(text, d, io) : await viaSystem(text, io);
    io.log(`🩺 带外通知[${ev.kind}] ${scrub(result, token)}：${text}`);
  } catch (e) {
    io.log(`🩺 带外通知失败: ${scrub((e as Error).message, token)}`);
  }
}

export function realOobIo(log: (line: string) => void): OobIo {
  return {
    mode: () => readSideMode(OOB_CONFIG_KEY),
    platform: process.platform,
    discord: () => ({ token: process.env.DISCORD_BOT_TOKEN || "", channelId: process.env.CONTROL_CHANNEL_ID || "" }),
    hostname,
    fetch: (url, init) => fetch(url, init),
    exec: execWithTimeout,
    log,
  };
}
