/**
 * `ledger` 命令的身份与参数（docs 10-ledger §2）：actor 由环境推导，时间由命令填，调用方只给内容。
 * 身份是自报的：agent 在自己的 Bash 里 unset DISCORD_CHANNEL_ID 就成了 owner——权限只防手滑，不是安全边界（设计稿 §2）。
 * 纯函数，tests/manager-ledger-identity.test.ts。
 */

import { LEND_WORKER_MARK } from "../lib/runtimes/clean-env.js";

export type ActorResult = { ok: true; actor: string } | { ok: false; error: string };

/**
 * 没有 DISCORD_CHANNEL_ID（终端）→ owner；等于控制频道 → master；registry 里某个 agent 的频道 → 它的 registry 键（agent-xxx）。
 * 查不到的频道直接拒绝：可能是已删的 agent 或别处注入的变量，降级成 owner 就等于白送最高权限。
 * 控制频道要先判：大总管的 registry 条目（agent-master）可能也登记着同一个频道。
 */
export function resolveActor(
  env: { channelId?: string; controlChannelId?: string },
  agents: Record<string, { channelId?: string }>,
  lendWorkerMark = process.env[LEND_WORKER_MARK],
): ActorResult {
  // 出借 worker 的环境里本来就没有频道号，不先拦就会被当成 owner：外来任务能自己改 lend.json、延长预先授权、替 owner 答 ask
  if (lendWorkerMark) return { ok: false, error: "出借 worker 不能以本机身份写台账或改声明" };
  const ch = env.channelId?.trim();
  if (!ch) return { ok: true, actor: "owner" };
  if (env.controlChannelId && ch === env.controlChannelId.trim()) return { ok: true, actor: "master" };
  const hit = Object.entries(agents).find(([, v]) => v.channelId === ch);
  if (hit) return { ok: true, actor: hit[0] };
  return { ok: false, error: `认不出身份：频道 ${ch} 既不是控制频道，也不属于 registry 里任何 agent，拒绝写台账` };
}

/** 命令行写的 agent 名 → tasks.agent / pm 名单用的 registry 键；master / owner 原样 */
export function agentKey(raw: string): string {
  const t = raw.trim();
  if (t === "master" || t === "owner") return t;
  return `agent-${t.replace(/^agent-/, "").toLowerCase()}`;
}

export interface ParsedArgs {
  pos: string[];
  flags: Record<string, string>;
  bools: Set<string>;
}

/**
 * `--k v` / `--k=v` 取值，bools 里的是开关；不认识的旗标、值缺失都报错（拼错的旗标悄悄当位置参数，会把 --form 写进 note 正文）。
 * `--` 之后全是位置参数，正文以 - 开头时用。
 */
export function parseLedgerArgs(args: readonly string[], valued: readonly string[], bools: readonly string[] = []): ParsedArgs | { error: string } {
  const out: ParsedArgs = { pos: [], flags: {}, bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.pos.push(...args.slice(i + 1));
      break;
    }
    const m = a.match(/^--([a-z0-9-]+)(?:=(.*))?$/s);
    if (!m) {
      out.pos.push(a);
      continue;
    }
    const [, name, inline] = m;
    if (bools.includes(name) && inline === undefined) out.bools.add(name);
    else if (valued.includes(name)) {
      const v = inline ?? args[++i];
      if (v === undefined) return { error: `--${name} 缺少值` };
      out.flags[name] = v;
    } else return { error: `不认识的参数 --${name}` };
  }
  return out;
}

/** 非负整数旗标；没写返回 undefined */
export function intFlag(p: ParsedArgs, name: string): number | undefined {
  const v = p.flags[name];
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v.trim())) throw new Error(`--${name} 要是非负整数，收到 ${v}`);
  return Number(v);
}

/** --extra 的 JSON 对象 */
export function jsonObjectFlag(p: ParsedArgs, name: string): Record<string, unknown> | undefined {
  const v = p.flags[name];
  if (v === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch (e) {
    throw new Error(`--${name} 不是合法 JSON：${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`--${name} 要是 JSON 对象`);
  return parsed as Record<string, unknown>;
}
