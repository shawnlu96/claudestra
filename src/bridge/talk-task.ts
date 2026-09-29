/**
 * 从 Chat 勾几条消息「新建任务」：要能读台账（canReadLedger，和台账 API 同一道门；guest、部分 scope 的 owner 设备、集成 token 在网页和 API 两层都拒）。
 * 台账只由 CLI 写：经 runManager 调 `ledger task-new`，再 `ledger note` 把勾选的原文记在任务上（人写的，按外部文本存）。
 * 子进程环境去掉 DISCORD_CHANNEL_ID，ledger 的身份推导就落到 owner（lib 里 resolveActor：没有频道 = 终端 = owner）；
 * 两步各带 dedup，网络重试 / 连点不会建出两条。
 */
import { canReadLedger } from "../lib/devices.js";
import { runManagerProcess } from "../lib/run-manager.js";
import type { Principal } from "../lib/principals.js";
import { renderTalkExcerpt } from "../lib/talk-drop-render.js";
import { TASK_REQ_RE } from "../lib/talk-schema.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";
import { buildLines, type DropError } from "./talk-drop.js";
import type { Me } from "./talk.js";

const KINDS = ["code", "investigate", "ops"] as const;
const ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

type Runner = (args: string[]) => Promise<{ ok?: boolean; error?: string; task?: Record<string, unknown> } | null>;
const ownerEnv = (): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...ENV_WITH_BUN };
  delete env.DISCORD_CHANNEL_ID;
  return env;
};
const viaManager: Runner = (args) => runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ownerEnv(), timeoutMs: 60_000 });
let run = viaManager;

export function setTalkTaskRunnerForTest(r: Runner | undefined): void {
  run = r ?? viaManager;
}

export async function createTaskFromTalk(me: Me, principal: Principal, b: Record<string, unknown>): Promise<Record<string, unknown> | DropError> {
  if (!canReadLedger(principal)) return { status: 403, error: "creating ledger tasks needs a device that can read the ledger" };
  const { project, id, title, kind, req } = b;
  if (typeof project !== "string" || !PROJECT_RE.test(project)) return { status: 400, error: "project required" };
  if (typeof id !== "string" || !ID_RE.test(id)) return { status: 400, error: "task id must look like T123" };
  if (typeof title !== "string" || !title.trim() || title.length > 120) return { status: 400, error: "title required (≤ 120 chars)" };
  if (!KINDS.includes(kind as (typeof KINDS)[number])) return { status: 400, error: `kind must be ${KINDS.join(" / ")}` };
  if (typeof req !== "string" || !TASK_REQ_RE.test(req)) return { status: 400, error: "req must match tt_<uuid>" };
  const built = await buildLines(me, principal, b);
  if ("status" in built) return built;
  const cleanTitle = title.replace(/[\r\n]+/g, " ").trim();
  const extra = JSON.stringify({ talk: { room: b.room, msgs: built.msgs } });
  const made = await run(["ledger", "task-new", id, `--project=${project}`, `--title=${cleanTitle}`, `--kind=${kind}`, `--extra=${extra}`, `--dedup=talk-task:${req}`]);
  if (!made?.ok) return { status: 409, error: made?.error ?? "ledger task-new failed" };
  const note = await run(["ledger", "note", id, `--dedup=talk-note:${req}`, "--", renderTalkExcerpt(built.excerpt)]);
  if (!note?.ok) console.error(`⚠️ 从 Chat 建任务 ${id}：任务建了，原文没记上: ${note?.error ?? "?"}`);
  console.log(`🗂 从 Chat 建任务 ${project}/${id}（${built.msgs.length} 条原文）`);
  return { ok: true, task: made.task ?? { id }, noted: !!note?.ok };
}
