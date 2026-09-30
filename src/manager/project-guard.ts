/**
 * 改项目目录（project-add / project-edit --dirs / project-merge）只许 owner、master、目标项目的 PM（merge 要 src、dst 两边都是）：
 * 台账 verify 按项目目录判任务归不归本仓库（ledger-verify.ts），执行者要是能改目录，就能把自己的任务改成「不属于」、只核证据放行。
 * 身份沿用台账的 resolveActor（看 DISCORD_CHANNEL_ID）：没有频道 = owner（终端 / bridge / 网页转来的），控制频道 = master；
 * PM 按目标项目台账 meta 的 pms 判，和 ledger 按任务所属项目判角色同一口径（新建项目还没有 PM，只剩 owner / master）。
 * 身份是自报的，这道校验防手滑、不是安全边界（ledger-identity.ts）。tests/project-guard.test.ts。
 */
import { existsSync } from "node:fs";
import { repoEnvVar } from "../lib/env-file.js";
import { getMeta, LEDGER_PATH, openLedger } from "../lib/ledger-store.js";
import { loadRegistry } from "./core.js";
import { resolveActor } from "./ledger-identity.js";

type Denied = { error: string; tpl: string; params: Record<string, string> };

/** actor 是不是每个目标项目的 PM（台账库还没建时谁都不是） */
function pmOfAll(actor: string, targets: readonly string[], path: string): boolean {
  if (path !== ":memory:" && !existsSync(path)) return false;
  const db = openLedger(path);
  return targets.every((id) => getMeta(db, id).pms.includes(actor));
}

/** 能改 → null，不能 → 报错（带 tpl + params，网页按模板翻译）。env 是 DISCORD_CHANNEL_ID 与控制频道号，agents 是 registry */
export function projectWriterError(
  env: { channelId?: string; controlChannelId?: string },
  agents: Record<string, { channelId?: string }>,
  targets: readonly string[],
  ledgerPath: string,
): Denied | null {
  const who = resolveActor(env, agents);
  if (!who.ok) {
    const tpl = "认不出调用方的身份：改项目目录要找 PM 或 owner（网页 / master）";
    return { error: `${who.error}；${tpl}`, tpl, params: {} };
  }
  if (who.actor === "owner" || who.actor === "master" || pmOfAll(who.actor, targets, ledgerPath)) return null;
  const params = { actor: who.actor, projects: targets.join(" / ") };
  const tpl = "{actor} 不是项目 {projects} 的 PM，不能改项目目录：改项目目录要找 PM 或 owner（网页 / master）";
  return { error: tpl.replace(/\{(\w+)\}/g, (m, k: string) => params[k as keyof typeof params] ?? m), tpl, params };
}

export async function requireProjectWriter(targets: readonly string[]): Promise<Denied | null> {
  const env = { channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") };
  return projectWriterError(env, (await loadRegistry()).agents, targets, LEDGER_PATH);
}

/**
 * 只许 owner / master：出借 / 借入声明（lend.json）与取消「个人项目」标记——这两件决定的是「什么能交给别人的机器」，
 * 不是某个项目内部的事，PM 与执行者都不该能改（设计稿 remote-capacity §1「只有 owner 能改」）。同样只防手滑。
 */
export function ownerOrMasterError(env: { channelId?: string; controlChannelId?: string }, agents: Record<string, { channelId?: string }>, what: string): Denied | null {
  const who = resolveActor(env, agents);
  if (who.ok && (who.actor === "owner" || who.actor === "master")) return null;
  const params = { actor: who.ok ? who.actor : "?", what };
  const tpl = "{actor} 不能{what}：只有 owner（网页 / 终端）或 master 能改";
  return { error: tpl.replace(/\{(\w+)\}/g, (m, k: string) => params[k as keyof typeof params] ?? m), tpl, params };
}

export async function requireOwnerOrMaster(what: string): Promise<Denied | null> {
  const env = { channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") };
  return ownerOrMasterError(env, (await loadRegistry()).agents, what);
}
