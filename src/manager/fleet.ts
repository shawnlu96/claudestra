/**
 * `manager fleet`：批量管理的 CLI 入口（给 cron 和 PM 用），经 bridge 的 ws `fleet_run` / `fleet_state` 执行——
 * 发键、判态、留痕都在 bridge 里（bridge/fleet/），这里只拼请求、打印结果。
 *   manager fleet state
 *   manager fleet <lp-on|lp-off|compact|save-compact|lp-compact> --agents a,b | --project p | --all [--walled] [--ctx-over N] [--dry-run]
 * 群发文字、自定义保留清单、带上大总管只在网页上用 owner 设备做：ws 入口认不出调用方是不是 owner，一律拒收（bridge/fleet/ws.ts）。
 */
import { bridgeRequest } from "../lib/bridge-client.js";
import { FLEET_ACTIONS, parseFleetAction, parseFleetSelect } from "../lib/fleet-plan.js";
import { output } from "./core.js";

const USAGE = `usage: fleet state | fleet <${FLEET_ACTIONS.filter((k) => k !== "text").join("|")}> --agents a,b|--project p|--all [--walled] [--ctx-over N] [--dry-run]`;
/** 每个 agent 最长约 25 秒（开 LP 8s + 打断 5s + 等压缩开始 10s），4 路并发；给足余量 */
const RUN_TIMEOUT_MS = 10 * 60_000;

function takeValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined ? 1 : 2);
  return v;
}

function takeBool(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

export async function cmdFleet(argv: string[]): Promise<void> {
  const args = [...argv];
  const verb = args.shift();
  if (!verb) return output({ ok: false, error: USAGE });
  if (verb === "state") return output({ ok: true, ...(await bridgeRequest({ type: "fleet_state" }, { timeoutMs: 60_000 })) });
  const agents = takeValue(args, "--agents");
  const project = takeValue(args, "--project");
  const ctxOver = takeValue(args, "--ctx-over");
  const select = {
    ...(agents ? { agents: agents.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(project ? { project } : {}),
    ...(takeBool(args, "--all") ? { all: true } : {}),
    ...(takeBool(args, "--walled") ? { walled: true } : {}),
    ...(ctxOver !== undefined ? { ctxOver: Number(ctxOver) } : {}),
  };
  const dryRun = takeBool(args, "--dry-run");
  if (args.length) return output({ ok: false, error: `看不懂的参数：${args.join(" ")}\n${USAGE}` });
  const a = parseFleetAction({ kind: verb });
  if (!a.ok) return output({ ok: false, error: `${a.error}\n${USAGE}` });
  const s = parseFleetSelect(select);
  if (!s.ok) return output({ ok: false, error: `${s.error}\n${USAGE}` });
  const report = await bridgeRequest({ type: "fleet_run", action: a.action, select: s.select, dryRun }, { timeoutMs: RUN_TIMEOUT_MS });
  output({ ok: true, ...report });
}
