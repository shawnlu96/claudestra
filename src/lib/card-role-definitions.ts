/**
 * 本机卡片 agent 的角色定义：仓库 `.claude/agents/card-<角色>.md`（Claude Code 原生 subagent 格式），在这里翻成 `manager create`
 * 真认的参数（--model / --disallowed / --purpose），三个正式创建入口各包一层。只管 Claude 家族，别的家族原样放行。
 * 定义缺失 / 损坏 / 放宽了角色应有的边界、显式模型为空：create 不发出，回 ok:false 和诊断，不回落全局模型、不悄悄去掉只读。
 * 定义只收紧，不授予任何权限。测试：tests/card-role-definitions.test.ts、tests/card-role-create.test.ts。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerRole } from "./agent-lifecycle-store.js";
import { DISALLOWED_PRESETS } from "./claude-launch.js";
import { parseDisallowedRules, validateDisallowedRules } from "./disallowed-rules.js";
import { isCodexModel } from "./lend-config.js";
import { SRC_DIR } from "./repo-root.js";

export const CARD_ROLES = ["author", "reviewer", "adversarial-reviewer", "pm-reviewer"] as const;
export type CardRole = (typeof CARD_ROLES)[number];
const isCardRole = (v: unknown): v is CardRole => CARD_ROLES.includes(v as CardRole);

/** 每个角色固定的 LIFE1 登记身份与只读性：由角色决定，定义文件只能照写，写别的就算损坏（定义不能给自己换身份或放开写权限） */
const ROLE_SHAPE: Record<CardRole, { cardRole: WorkerRole; readOnly: boolean }> = {
  author: { cardRole: "author", readOnly: false },
  reviewer: { cardRole: "reviewer", readOnly: true },
  "adversarial-reviewer": { cardRole: "reviewer", readOnly: true },
  "pm-reviewer": { cardRole: "other", readOnly: true },
};

/** 本机 Claude 卡片角色的缺省模型（每个定义文件里写的就是它，这里供测试与诊断对照） */
export const CARD_DEFAULT_MODEL = "claude-opus-5-5";
export const CARD_ROLE_DIR = join(SRC_DIR, "..", ".claude", "agents");
let roleDir = CARD_ROLE_DIR;
/** Tests only: point the production entries at a synthetic definitions dir (undefined = back to the repo's). */
export function useCardRoleDir(dir?: string): void { roleDir = dir ?? CARD_ROLE_DIR; }
/**
 * 只读角色的硬下限。整个 Bash 都拦：bypassPermissions 下按命令前缀列黑名单拦不住 `printf x > f` / `bun -e writeFileSync`，
 * 只有不给 Bash 才是 Claude Code 自己执行的只读边界。少一条算定义损坏。审查报告写在审查目录外（Write 只拦 ./**）。
 */
export const READ_ONLY_FLOOR = ["Bash", "Edit(./**)", "Write(./**)", "MultiEdit(./**)", "NotebookEdit(./**)"] as const;
/** claude-launch.ts buildClaudeCommand 把 purpose 截到这么长；职责放在这个预算内才保证整段进 --append-system-prompt */
const LAUNCH_PURPOSE_LIMIT = 500;
/** 职责段（含标题行）上限：给调用方原 purpose（卡号、标题、工作单路径）至少留 LAUNCH_PURPOSE_LIMIT - 这个数 */
export const DUTIES_LIMIT = 360;
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
export const dutiesOf = (def: Pick<CardRoleDefinition, "name" | "body">) => `【卡片角色 ${def.name}】\n${def.body}`;

function parseCardRole(role: CardRole, file: string, md: string): CardRoleDefinition | { error: string } {
  const bad = (why: string) => ({ error: `角色定义 ${file} 损坏：${why}` });
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return bad("缺 frontmatter");
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = m[2].trim(), shape = ROLE_SHAPE[role];
  if (fm.name !== `card-${role}`) return bad(`name 应为 card-${role}（是 ${JSON.stringify(fm.name ?? "")}）`);
  if (!fm.description) return bad("缺 description");
  if (!body) return bad("正文（职责）为空");
  const duties = dutiesOf({ name: fm.name, body });
  if (duties.length > DUTIES_LIMIT) return bad(`职责 ${duties.length} 字超过 ${DUTIES_LIMIT}，启动时会被截断`);
  if (!fm.model || !CLAUDE_MODEL_RE.test(fm.model) || !isCodexModel(fm.model)) return bad(`model 要写完整的 Claude 模型 id（是 ${JSON.stringify(fm.model ?? "")}）`);
  if (fm["card-role"] !== shape.cardRole) return bad(`card-role 应为 ${shape.cardRole}（是 ${JSON.stringify(fm["card-role"] ?? "")}）`);
  if (fm["read-only"] !== String(shape.readOnly)) return bad(`read-only 应为 ${shape.readOnly}（是 ${JSON.stringify(fm["read-only"] ?? "")}）`);
  const raw = fm.disallowedTools ?? "";
  const invalid = raw ? validateDisallowedRules(raw) : undefined;
  if (invalid) return bad(`disallowedTools：${invalid}`);
  const disallowedTools = raw ? parseDisallowedRules(raw) : [];
  const missing = READ_ONLY_FLOOR.filter((r) => !disallowedTools.includes(r));
  if (shape.readOnly && missing.length) return bad(`只读角色的 disallowedTools 缺 ${missing.join(" ")}`);
  return { role, file, name: fm.name, description: fm.description, model: fm.model, cardRole: shape.cardRole, readOnly: shape.readOnly, disallowedTools, body };
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

/** 调用方原 purpose 截到给职责留足预算，职责接在后面：合起来不超过启动器的截断长度 */
function withDuties(purpose: string, duties: string): string {
  const room = LAUNCH_PURPOSE_LIMIT - duties.length - 2;
  const head = purpose.trim();
  if (!head) return duties;
  return `${head.length > room ? `${head.slice(0, room - 1)}…` : head}\n\n${duties}`;
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
 * 没给显式角色的 --card-role other：原样返回（三个正式入口只建 author / reviewer，对抗式轮次由同一个 reviewer 会话按工作单做）。
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
  const model = flagValue(args, "--model");
  if (model && (!model.value?.trim() || model.value.trim().startsWith("-"))) {
    return { error: `${def.name} 的 create 带了无效的 --model ${JSON.stringify(model.value ?? "")}（启动器会忽略它、回落全局模型）；没有建会话` };
  }
  const duties = dutiesOf(def), boundary = [...DISALLOWED_PRESETS.default, ...def.disallowedTools].join(" ");
  const purpose = flagValue(args, "--purpose");
  // 嵌套的入口（runStart 里再套 runLocalStart）已经整套加过：模型、这份边界原文、职责原文都在才算，不重复追加
  if (model && (purpose?.value === duties || purpose?.value?.endsWith(`\n\n${duties}`))
    && (def.disallowedTools.length ? flagValue(args, "--disallowed")?.value === boundary : true)) return { args };
  const out = [...args];
  if (!model) out.push("--model", def.model);
  if (def.disallowedTools.length) {
    const taken = flagValue(out, "--preset") ?? flagValue(out, "--disallowed");
    if (taken) return { error: `${def.name} 要用定义里的工具边界，这次 create 已带 ${out[taken.index]}，不覆盖也不放宽；没有建会话` };
    out.push("--disallowed", boundary);
  }
  if (!purpose) out.push("--purpose", duties);
  else if (out[purpose.index] === "--purpose") out[purpose.index + 1] = withDuties(purpose.value ?? "", duties);
  else out[purpose.index] = `--purpose=${withDuties(purpose.value ?? "", duties)}`;
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
