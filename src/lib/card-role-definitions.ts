/**
 * ROLE1 本机卡片 agent 的角色定义：仓库 `.claude/agents/card-<角色>.md`（Claude Code 原生 subagent 格式：frontmatter + 正文），
 * 由这里读成 `manager create` 真认的参数，三个正式创建入口（scheduler-auto-deps createReviewer、scheduler-local-author
 * ensureLocalAuthor、scheduler-local-runtime-start runLocalStart）各包一层 cardRoleCreate / cardRoleManager。
 *
 * 为什么是 `.claude/agents` 而不是 roles/ + team-roles.ts：roles/ 是编排班子（pm / dispatcher / executor）按 registry role
 * 落盘成 --agents / --append-system-prompt-file 的，卡片 worker 不走那条（create 只认 --card / --card-role）；原生格式在仓库里
 * 一眼可审（name / description / model / disallowedTools 都是 Claude Code 自己的字段），本仓会话也能当 subagent 直接用。
 * 只加原生文件 manager create 不会读，所以由本模块翻成 create argv：
 *   model           → 没显式 --model 时补 `--model <id>`（显式的保留）；
 *   disallowedTools → `--disallowed "<default 预设 + 定义里的规则>"`，走 Claude Code --disallowedTools 硬拦截，不靠提示词自称只读；
 *   正文            → 接在 --purpose 后面，manager create 把 purpose 注入 --append-system-prompt，agent 启动即加载职责。
 * 只管 Claude 家族：带 --runtime codex / pi 的 create 原样放行（不把 Claude 模型递给别的家族，也不猜它们的配置）。
 * 定义缺失 / 损坏 / 模型非法 / card-role 对不上 / 调用方已带别的权限清单：create 不发出，直接回 ok:false 和诊断，
 * 不回落到全局默认模型、不悄悄去掉只读。定义只做收紧，不授予任何权限（PM 写库 / 合并照旧由 caller 票据和 guard 管）。
 * tests/card-role-definitions.test.ts、tests/card-role-create.test.ts。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isWorkerRole, type WorkerRole } from "./agent-lifecycle-store.js";
import { DISALLOWED_PRESETS } from "./claude-launch.js";
import { parseDisallowedRules, validateDisallowedRules } from "./disallowed-rules.js";
import { isCodexModel } from "./lend-config.js";
import { SRC_DIR } from "./repo-root.js";

export const CARD_ROLES = ["author", "reviewer", "adversarial-reviewer", "pm-reviewer"] as const;
export type CardRole = (typeof CARD_ROLES)[number];
export const isCardRole = (v: unknown): v is CardRole => CARD_ROLES.includes(v as CardRole);

/** owner 10:29 决定：本机 Claude 卡片角色缺省钉这个模型（写在每个定义文件里，这里供测试与诊断对照） */
export const CARD_DEFAULT_MODEL = "claude-opus-5-5";
export const CARD_ROLE_DIR = join(SRC_DIR, "..", ".claude", "agents");
let roleDir = CARD_ROLE_DIR;
/** Tests only: point the production entries at a synthetic definitions dir (undefined = back to the repo's). */
export function useCardRoleDir(dir?: string): void { roleDir = dir ?? CARD_ROLE_DIR; }
/** 只读角色至少要拦住这几条（在 agent 自己的工作目录里改文件）；少了算定义损坏 */
const READ_ONLY_FLOOR = ["Edit(./**)", "Write(./**)", "MultiEdit(./**)", "NotebookEdit(./**)"];
const CLAUDE_MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]*$/;

export interface CardRoleDefinition {
  role: CardRole;
  file: string;
  name: string;
  description: string;
  model: string;
  /** LIFE1 登记用的 --card-role，必须和 create 实际带的一致 */
  cardRole: WorkerRole;
  readOnly: boolean;
  disallowedTools: string[];
  body: string;
}

const fileOf = (role: CardRole, dir: string) => join(dir, `card-${role}.md`);

export function parseCardRole(role: CardRole, file: string, md: string): CardRoleDefinition | { error: string } {
  const bad = (why: string) => ({ error: `角色定义 ${file} 损坏：${why}` });
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return bad("缺 frontmatter");
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = m[2].trim();
  if (fm.name !== `card-${role}`) return bad(`name 应为 card-${role}（是 ${JSON.stringify(fm.name ?? "")}）`);
  if (!fm.description) return bad("缺 description");
  if (!body) return bad("正文（职责）为空");
  if (!fm.model || !CLAUDE_MODEL_RE.test(fm.model) || !isCodexModel(fm.model)) return bad(`model 要写完整的 Claude 模型 id（是 ${JSON.stringify(fm.model ?? "")}）`);
  if (!isWorkerRole(fm["card-role"])) return bad(`card-role 只能是 author / reviewer / other（是 ${JSON.stringify(fm["card-role"] ?? "")}）`);
  if (fm["read-only"] !== "true" && fm["read-only"] !== "false") return bad("read-only 要写 true 或 false");
  const readOnly = fm["read-only"] === "true";
  const raw = fm.disallowedTools ?? "";
  const invalid = raw ? validateDisallowedRules(raw) : undefined;
  if (invalid) return bad(`disallowedTools：${invalid}`);
  const disallowedTools = raw ? parseDisallowedRules(raw) : [];
  const missing = READ_ONLY_FLOOR.filter((r) => !disallowedTools.includes(r));
  if (readOnly && missing.length) return bad(`只读角色的 disallowedTools 缺 ${missing.join(" ")}`);
  return { role, file, name: fm.name, description: fm.description, model: fm.model, cardRole: fm["card-role"], readOnly, disallowedTools, body };
}

export function loadCardRole(role: unknown, dir = roleDir): CardRoleDefinition | { error: string } {
  if (!isCardRole(role)) return { error: `没有卡片角色 ${JSON.stringify(role)}（只有 ${CARD_ROLES.join(" / ")}）` };
  const file = fileOf(role, dir);
  let md: string;
  try { md = readFileSync(file, "utf-8"); } catch (e) { return { error: `读不到角色定义 ${file}：${(e as Error).message}` }; }
  return parseCardRole(role, file, md);
}

/** 自由文本的值（--purpose / --task 后面那一格）不当 flag 认 */
const FREE_TEXT = new Set(["--purpose", "--task"]);

function flagValue(args: string[], flag: string): { index: number; value: string | undefined } | null {
  for (let i = 0; i < args.length; i++) {
    if (FREE_TEXT.has(args[i]) && args[i] !== flag) { i++; continue; }
    if (args[i] === flag) return { index: i, value: args[i + 1] };
    if (args[i].startsWith(`${flag}=`)) return { index: i, value: args[i].slice(flag.length + 1) };
  }
  return null;
}

export interface CardRoleOptions {
  /** 定义目录；不给 = 仓库 .claude/agents（测试可用 useCardRoleDir 换） */
  dir?: string;
  /** 显式角色（对抗式 / pm-reviewer 这类不能从 --card-role 推出的）；不给按 --card-role author / reviewer 取 */
  role?: CardRole;
  /** 入口已选定的家族（runLocalStart 的 runtime）：不是 claude 就原样放行——Codex 的 --runtime 由更外层追加，这层看不到 */
  family?: string;
}

/**
 * 卡片 create 的最终 argv → 加载了角色定义的 argv，或不该发出的诊断。非 create、没带 --card-role、别的家族、
 * 推不出角色的 --card-role other：原样返回。
 */
export function applyCardRole(args: string[], opts: CardRoleOptions = {}): { args: string[] } | { error: string } {
  if (args[0] !== "create") return { args };
  const card = flagValue(args, "--card-role")?.value;
  if (card === undefined) return { args };
  const runtime = flagValue(args, "--runtime")?.value;
  if (runtime !== undefined && runtime !== "claude-code" && runtime !== "claude") return { args };
  if (opts.family !== undefined && opts.family !== "claude") return { args };
  const role = opts.role ?? (card === "author" || card === "reviewer" ? card : undefined);
  if (!role) return { args };
  const def = loadCardRole(role, opts.dir);
  if ("error" in def) return { error: `${def.error}；没有建会话` };
  if (def.cardRole !== card) return { error: `角色定义 ${def.file} 登记为 --card-role ${def.cardRole}，这次 create 带的是 ${card}；没有建会话` };
  const duties = `【卡片角色 ${def.name}】\n${def.body}`, boundary = [...DISALLOWED_PRESETS.default, ...def.disallowedTools].join(" ");
  const purpose = flagValue(args, "--purpose");
  // 嵌套的入口（runStart 里再套 runLocalStart）已经整套加过：模型、这份边界原文、职责原文都在才算，不重复追加
  if (flagValue(args, "--model") && (purpose?.value === duties || purpose?.value?.endsWith(`\n\n${duties}`))
    && (def.disallowedTools.length ? flagValue(args, "--disallowed")?.value === boundary : true)) return { args };
  const out = [...args];
  if (!flagValue(out, "--model")) out.push("--model", def.model);
  if (def.disallowedTools.length) {
    const taken = flagValue(out, "--preset") ?? flagValue(out, "--disallowed");
    if (taken) return { error: `${def.name} 要用定义里的工具边界，这次 create 已带 ${out[taken.index]}，不覆盖也不放宽；没有建会话` };
    out.push("--disallowed", boundary);
  }
  if (!purpose) out.push("--purpose", duties);
  else if (out[purpose.index] === "--purpose") out[purpose.index + 1] = `${purpose.value ?? ""}\n\n${duties}`;
  else out[purpose.index] = `--purpose=${purpose.value}\n\n${duties}`;
  return { args: out };
}

type Create = (...args: string[]) => Promise<Record<string, unknown>>;

/** 变参 manager（scheduler-auto-deps / scheduler-local-author 的 env.create）外包一层：坏定义就不调 create */
export function cardRoleCreate<T extends Create>(create: T, opts: CardRoleOptions = {}): T {
  return (async (...args: string[]) => {
    const r = applyCardRole(args, opts);
    return "error" in r ? { ok: false, error: r.error } : create(...r.args);
  }) as T;
}

/** StepIO.manager（start_node 的 runStart）外包一层，语义同 cardRoleCreate */
export function cardRoleManager<T extends (args: string[], timeoutMs?: number) => Promise<any>>(manager: T, opts: CardRoleOptions = {}): T {
  return (async (args: string[], timeoutMs?: number) => {
    const r = applyCardRole(args, opts);
    return "error" in r ? { ok: false, error: r.error } : manager(r.args, timeoutMs);
  }) as T;
}

/** runLocalStart 的 io：manager 每次现取调用方 io 上的那个（排队重试时调用方换过 manager 也照用新的），其余字段照抄 */
export function cardRoleIo<T extends { manager: (args: string[], timeoutMs?: number) => Promise<any> }>(io: T, opts: CardRoleOptions = {}): T {
  return { ...io, manager: cardRoleManager((args: string[], timeoutMs?: number) => io.manager(args, timeoutMs), opts) };
}
