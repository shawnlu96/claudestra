export const runtime = "nodejs";

import { appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { isAuthed } from "@/lib/api-auth";

/**
 * 前端恢复动作存档(2026-07-24):「web 收不到消息」类事故反复出现,但 iOS 上
 * 无法取证前端当时做了什么(看不到 console)——关键恢复路径(watchdog 判死/
 * 重连/强制对齐)打点到这里,下次事故直接对时间线。只记恢复事件,低频。
 */
const LOG = join(
  process.env.CLAUDESTRA_DATA_ROOT || join(homedir(), ".claude-orchestrator", "web"),
  "client.log"
);

export async function POST(request: Request) {
  if (!(await isAuthed(request))) return new Response(null, { status: 401 });
  const { msg } = await request.json().catch(() => ({ msg: "" }));
  if (typeof msg !== "string" || !msg) return new Response(null, { status: 400 });
  const ua = (request.headers.get("user-agent") || "").slice(0, 40);
  // v2.21.3+ 错误上报([shell]/[pwa] error …)带完整 JS 栈(含列号,配合
  // productionBrowserSourceMaps 用 scripts/resolve-stack.mjs 还原到源码),放宽到
  // 2000 字;其他打点仍 300 字。换行折成 ⏎,日志保持一行一条便于 grep。
  const cap = /^\[(shell|pwa)\] error |^\[loop\] |^\[commits\] /.test(msg) ? 3200 : 300;
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${msg.slice(0, cap).replace(/\r?\n/g, " ⏎ ")} | ${ua}\n`);
  } catch {
    /* ignore */
  }
  return new Response(null, { status: 204 });
}
