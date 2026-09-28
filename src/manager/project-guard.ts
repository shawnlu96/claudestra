/**
 * 改项目目录（project-add / project-edit --dirs / project-merge）只许 owner、master、PM：
 * 台账 verify 按项目目录判任务归不归本仓库（ledger-verify.ts），执行者要是能改目录，就能把自己的任务改成「不属于」、只核证据放行。
 * 身份沿用台账的 resolveActor（看 DISCORD_CHANNEL_ID）：没有频道 = owner（终端 / bridge / 网页转来的），控制频道 = master；
 * PM = 任一项目台账 meta 里 pms 名单上的 agent。和 ledger task-set 不收 --project 同一口径。tests/project-guard.test.ts。
 */
import { existsSync } from "node:fs";
import { repoEnvVar } from "../lib/env-file.js";
import { getMeta, LEDGER_PATH, openLedger } from "../lib/ledger-store.js";
import type { ProjectDef } from "../lib/projects.js";
import { loadRegistry } from "./core.js";
import { resolveActor } from "./ledger-identity.js";

const HOW = "改项目目录要找 PM 或 owner（网页 / master）";

/** 所有项目台账里登记的 PM（台账库还没建时为空：只剩 owner / master） */
function allPms(projects: readonly ProjectDef[], path: string): string[] {
  if (path !== ":memory:" && !existsSync(path)) return [];
  const db = openLedger(path);
  return [...new Set(projects.flatMap((p) => getMeta(db, p.id).pms))];
}

/** 能改 → null，不能 → 报错。env 是 DISCORD_CHANNEL_ID 与控制频道号，agents 是 registry */
export function projectWriterError(
  env: { channelId?: string; controlChannelId?: string },
  agents: Record<string, { channelId?: string }>,
  projects: readonly ProjectDef[],
  ledgerPath: string,
): string | null {
  const who = resolveActor(env, agents);
  if (!who.ok) return `${who.error}；${HOW}`;
  if (who.actor === "owner" || who.actor === "master" || allPms(projects, ledgerPath).includes(who.actor)) return null;
  return `${who.actor} 不能改项目目录：${HOW}`;
}

export async function requireProjectWriter(projects: readonly ProjectDef[]): Promise<string | null> {
  const env = { channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") };
  return projectWriterError(env, (await loadRegistry()).agents, projects, LEDGER_PATH);
}
