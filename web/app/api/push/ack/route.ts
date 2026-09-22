export const runtime = "nodejs";

import { appendFileSync } from "fs";
import { join } from "path";
import { DATA_ROOT } from "@/lib/data-root";

/**
 * 推送回执探针(2026-07-16 排障):SW 收到 push 事件时打一发,区分
 * 「APNs 没投递到设备」(无回执)vs「设备收到但没展示」(有回执无横幅)。
 * 无鉴权——SW 被系统唤醒时 cookie 场景不稳定,回执只写 tag+UA,无敏感数据。
 */
const LOG = join(DATA_ROOT, "push-ack.log");

export async function GET(request: Request) {
  const url = new URL(request.url);
  const line = `${new Date().toISOString()} tag=${url.searchParams.get("tag") || "?"} ua=${(request.headers.get("user-agent") || "").slice(0, 60)}\n`;
  try {
    appendFileSync(LOG, line);
  } catch {
    /* ignore */
  }
  return new Response(null, { status: 204 });
}
