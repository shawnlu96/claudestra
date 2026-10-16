/**
 * 本机卡片 agent 的角色定义：仓库 `.claude/agents/card-<角色>.md`（Claude Code 原生 subagent 格式），在这里翻成 `manager create`
 * 真认的参数（--model / --disallowed / --purpose），三个正式创建入口各包一层。只管 Claude 家族，别的家族原样放行。
 * 定义缺失 / 损坏 / 放宽了角色应有的边界、显式模型为空：create 不发出，回 ok:false 和诊断，不回落全局模型、不悄悄去掉只读。
 * 定义只收紧，不授予任何权限。模型经模型档位表的读端口取（role-model-settings-local.ts：缺省 observe 只记 would-use、启动参数不变）。
 * 带 opts.tier（调度器入口）时先问任务类型模型（task-tier-models.ts，taskTierModels 键）：off 整段走上面的旧路径；on 用类型有效值并记启动事实。
 * 测试：tests/card-role-definitions.test.ts、tests/card-role-create.test.ts、tests/role-model-settings-local.test.ts、tests/task-tier-models.test.ts。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerRole } from "./agent-lifecycle-store.js";
import { DISALLOWED_PRESETS } from "./claude-launch.js";
import { parseDisallowedRules, validateDisallowedRules } from "./disallowed-rules.js";
import { isCodexModel } from "./lend-config.js";
import { SRC_DIR } from "./repo-root.js";
import { pickRoleModel } from "./role-model-settings-local.js";
import { CARD_ROLES, isCardRoleName as isCardRole, type CardRole } from "./role-model-settings.js";
import { recordLaunchAttempt, recordLaunchFailed, type LaunchPlan } from "./task-tier-launch-events.js";
import { decideTierLaunch, type TierLaunchCtx } from "./task-tier-models.js";

export { CARD_DEFAULT_MODEL, CARD_ROLES, type CardRole } from "./role-model-settings.js";

/** 每个角色固定的 LIFE1 登记身份与只读性：由角色决定，定义文件只能照写，写别的就算损坏（定义不能给自己换身份或放开写权限） */
const ROLE_SHAPE: Record<CardRole, { cardRole: WorkerRole; readOnly: boolean }> = {
  author: { cardRole: "author", readOnly: false },
  reviewer: { cardRole: "reviewer", readOnly: true },
  "adversarial-reviewer": { cardRole: "reviewer", readOnly: true },
  "pm-reviewer": { cardRole: "other", readOnly: true },
};

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

/** 一段里按顺序抽掉的值 flag（同 core.ts extract*Flag：`--x v` 吃下一格、`--x=v` 一格） */
function strip(args: string[], flags: string[]): { rest: string[]; seen: string[] } {
  const rest: string[] = [], seen: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const f = flags.find((x) => a === x || a.startsWith(`${x}=`));
    if (!f) { rest.push(a); continue; }
    seen.push(a === f ? args[++i] ?? "" : a.slice(f.length + 1));
  }
  return { rest, seen };
}

/**
 * 正式启动器（src/manager/create-args.ts parseCreateArgs）看到的 --model / --effort：照它的抽取顺序先剥掉排在前面那些 flag 的值
 * （--purpose / --task 的自由文本、--project 等），剩下的才算模型 / 推理档参数，同名取最后一个。
 */
function launcherFlags(args: string[]): { model: string[]; effort: string[] } {
  let rest = args.slice(1);
  for (const stage of [["--purpose"], ["--project"], ["--card"], ["--card-role"], ["--parent", "--task", "--role"],
    ["--runtime"], ["--transport"], ["--pi-base"], ["--pi-preset"]]) rest = strip(rest, stage).rest;
  const model = strip(rest, ["--model"]);
  const effort = strip(strip(model.rest, ["--mode"]).rest, ["--effort"]);
  return { model: model.seen, effort: effort.seen };
}

/**
 * 类型档 on 下启动器实际取到的 --model / --effort 不止一个、或与核验用的值（flagValue 取第一个）不是同一个就拒：
 * 否则核验的值与实际启动的值可能不同。自由文本里形似 flag 的字样不算参数（与 parseCreateArgs 一致）。
 */
function repeatedFlag(args: string[]): string | null {
  const real = launcherFlags(args);
  for (const [flag, seen] of [["--model", real.model], ["--effort", real.effort]] as const) {
    if (seen.length > 1) return `${flag} 出现了 ${seen.length} 次（启动器取最后一个，核验不了实际值），只能给一个`;
    const checked = flagValue(args, flag)?.value;
    if (checked !== seen.at(-1)) return `${flag} 核验取到 ${JSON.stringify(checked ?? null)}，启动器会取 ${JSON.stringify(seen.at(-1) ?? null)}，对不上`;
  }
  return null;
}

/** start_node 的工作单指针：之后到结尾整段是路径（可含空格），不可分 */
const POINTER = "。先读 ";

/**
 * 调用方原 purpose 截到给职责留足预算，职责接在后面：合起来不超过启动器的截断长度。超长时从中间（标题）截，
 * 结尾的「。先读 <工作单路径>」整段原样保留（路径含空格也不拆）；没有这句时保留结尾那句或至少最后一个词。放不下就报错，不悄悄裁掉。
 */
function withDuties(purpose: string, duties: string): string | { error: string } {
  const room = LAUNCH_PURPOSE_LIMIT - duties.length - 2;
  const head = purpose.trim();
  if (!head) return duties;
  if (head.length <= room) return `${head}\n\n${duties}`;
  const pointer = head.lastIndexOf(POINTER);
  const lastWord = head.search(/\S+$/);
  if (pointer <= 0 && lastWord <= 0) return `${head.slice(0, room - 1)}…\n\n${duties}`;
  const keep = pointer > 0
    ? (head.length - pointer <= room - 2 ? pointer : undefined)
    : [head.lastIndexOf("。", lastWord), lastWord - 1].find((at) => at > 0 && head.length - at <= room - 2);
  const tail = pointer > 0 ? head.slice(pointer + POINTER.length) : head.slice(lastWord);
  if (keep === undefined) return { error: `purpose 结尾的「${tail}」放不进职责之外的 ${room} 字预算，截了就丢指针` };
  return `${head.slice(0, room - 1 - (head.length - keep))}…${head.slice(keep)}\n\n${duties}`;
}

export interface CardRoleOptions {
  /** 定义目录；不给 = 仓库 .claude/agents（测试可用 useCardRoleDir 换） */
  dir?: string;
  /** 显式角色（对抗式 / pm-reviewer 这类不能从 --card-role 推出的）；不给按 --card-role author / reviewer 取 */
  role?: CardRole;
  /** 入口已选定的家族（runLocalStart 的 runtime）：不是 claude 就原样放行——Codex 的 --runtime 由更外层追加，这层看不到 */
  family?: string;
  /** 模型档位表 / 恢复策略坏了时的诊断去处（照默认起照常发出 create，只是不静默）；不给 = console.warn */
  warn?: (msg: string) => void;
  /** 调度器入口给的类型上下文（卡上的流程模板、台账、轮次、自带的 Codex 档）；不给 = 不经类型模型选择，行为同 TIER1 */
  tier?: TierLaunchCtx;
}

type Applied = { args: string[]; roleModelDiagnostic?: string; tierLaunch?: LaunchPlan } | { error: string; tierLaunch?: LaunchPlan };

/**
 * 卡片 create 的最终 argv → 加载了角色定义的 argv，或不该发出的诊断。非 create、没带 --card-role、别的家族、
 * 没给显式角色的 --card-role other：原样返回（三个正式入口只建 author / reviewer，对抗式轮次由同一个 reviewer 会话按工作单做）。
 */
export function applyCardRole(args: string[], opts: CardRoleOptions = {}): Applied {
  if (args[0] !== "create") return { args };
  const card = flagValue(args, "--card-role")?.value;
  if (card === undefined) return { args };
  const runtime = flagValue(args, "--runtime")?.value;
  const role = opts.role ?? (card === "author" || card === "reviewer" ? card : undefined);
  const codex = runtime === "codex" || opts.family === "codex";
  if (runtime !== undefined && runtime !== "claude-code" && runtime !== "claude") return codex && role ? codexRoleModel(args, role, opts) : { args };
  if (opts.family !== undefined && opts.family !== "claude") return codex && role ? codexRoleModel(args, role, opts) : { args };
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
  // 嵌套的入口（runStart 里再套 runLocalStart）已经整套加过：模型、这份边界原文、职责原文都在才算，不重复追加。
  // 带类型上下文时去重不跳核验：已装饰的 --model 照样过重复参数与 security 下限（外层已记过启动尝试，这里通过只放行、拒绝才记）
  if (model && (purpose?.value === duties || purpose?.value?.endsWith(`\n\n${duties}`))
    && (def.disallowedTools.length ? flagValue(args, "--disallowed")?.value === boundary : true)) {
    if (!opts.tier) return { args };
    const again = decideTierLaunch(opts.tier, role, "claude", model.value?.trim() ?? null, args[1] ?? null);
    if (again.mode !== "on") return { args };
    const why = "error" in again ? again.error : repeatedFlag(args);
    return why ? { error: `${def.name}：${why}；没有建会话`, tierLaunch: again.plan } : { args };
  }
  const taken = def.disallowedTools.length ? flagValue(args, "--preset") ?? flagValue(args, "--disallowed") : null;
  if (taken) return { error: `${def.name} 要用定义里的工具边界，这次 create 已带 ${args[taken.index]}，不覆盖也不放宽；没有建会话` };
  const text = purpose ? withDuties(purpose.value ?? "", duties) : duties;
  if (typeof text !== "string") return { error: `${def.name}：${text.error}；没有建会话` };
  // 读表放在所有拒绝之后：observe 记的 would-use 只对应真会发出的 create
  const out = [...args];
  const tier = opts.tier ? decideTierLaunch(opts.tier, role, "claude", model?.value?.trim() ?? null, args[1] ?? null) : null;
  if (tier && "error" in tier) return { error: `${def.name}：${tier.error}；没有建会话`, tierLaunch: tier.plan };
  const tierOn = tier?.mode === "on" ? tier : null;
  const dup = tierOn ? repeatedFlag(args) : null;
  if (tierOn && dup) return { error: `${def.name}：${dup}；没有建会话`, tierLaunch: tierOn.plan };
  const pick = model || tierOn ? null : pickReported({ ...cardOf(args), role, family: "claude", explicit: false }, opts);
  if (pick) out.push("--model", pick.inject ?? def.model);
  if (tierOn && !model) out.push("--model", tierOn.value ?? def.model);
  if (def.disallowedTools.length) out.push("--disallowed", boundary);
  if (!purpose) out.push("--purpose", text);
  else if (out[purpose.index] === "--purpose") out[purpose.index + 1] = text;
  else out[purpose.index] = `--purpose=${text}`;
  if (tierOn) tierOn.plan.final.model = flagValue(out, "--model")?.value ?? null;
  return { args: out, ...(pick?.diagnostic ? { roleModelDiagnostic: pick.diagnostic } : {}), ...(tierOn ? { tierLaunch: tierOn.plan } : {}) };
}

const cardOf = (args: string[]) => ({ project: flagValue(args, "--project")?.value, card: flagValue(args, "--card")?.value });

/** 读表并把诊断（表坏 / 读不了 / 恢复策略坏）报出去：回落照旧安全，但不静默吞掉 */
function pickReported(ask: Parameters<typeof pickRoleModel>[0], opts: CardRoleOptions): ReturnType<typeof pickRoleModel> {
  const pick = pickRoleModel(ask);
  if (pick.diagnostic) (opts.warn ?? console.warn)(`⚠️ ${ask.role}（${ask.family}）的模型档位（${pick.mode}）：${pick.diagnostic}`);
  return pick;
}

/** Codex 卡只读表里的推理档（role-model-settings-local.ts）：on 且没显式 --effort 才追加，永不带 --model；其余原样 */
function codexRoleModel(args: string[], role: CardRole, opts: CardRoleOptions): Applied {
  if (opts.tier) {
    const tiered = codexTier(args, role, opts.tier);
    if (tiered) return tiered;
  }
  const pick = pickReported({ ...cardOf(args), role, family: "codex", explicit: !!flagValue(args, "--effort") }, opts);
  return { args: pick.inject ? [...args, "--effort", pick.inject] : args, ...(pick.diagnostic ? { roleModelDiagnostic: pick.diagnostic } : {}) };
}

/**
 * Codex 卡的类型档（on）：argv 里等于 baseEffort 的 --effort 是调用方自带的原档，按类型换掉；别的 --effort 是显式值，保留但过 security 下限。
 * null = 不是 on，回旧路径。
 */
function codexTier(args: string[], role: CardRole, ctx: TierLaunchCtx): Applied | null {
  const eff = flagValue(args, "--effort");
  const explicit = eff && eff.value !== ctx.baseEffort ? eff.value ?? "" : null;
  const d = decideTierLaunch(ctx, role, "codex", explicit, args[1] ?? null);
  if ("error" in d) return { error: `${role}（codex）：${d.error}；没有建会话`, tierLaunch: d.plan };
  if (d.mode !== "on") return null;
  const dup = repeatedFlag(args);
  if (dup) return { error: `${role}（codex）：${dup}；没有建会话`, tierLaunch: d.plan };
  if (explicit !== null) return { args, tierLaunch: d.plan };
  // 原档就地换值（argv 顺序不变）；解析成 null = 照 Codex 自己的配置，去掉 --effort
  const span = eff ? (args[eff.index] === "--effort" ? 2 : 1) : 0;
  const set = d.value === null ? [] : ["--effort", d.value];
  const out = eff ? [...args.slice(0, eff.index), ...set, ...args.slice(eff.index + span)] : [...args, ...set];
  return { args: out, tierLaunch: d.plan };
}

type Create = (...args: string[]) => Promise<Record<string, unknown>>;

/** 启动事实只是记录：记不上（台账忙 / 坏）不挡建卡，但不静默 */
function fact(what: string, write: () => unknown): void {
  try { write(); } catch (e) { console.error(`[task-tier] 记${what}失败（建卡照旧）：${(e as Error).message}`); }
}

/** 包装的公共段：坏定义 / 类型拒绝就不调 create；on 下每次尝试先记 attempt，create 没成另记 failed */
async function launchRecorded(r: Applied, opts: CardRoleOptions, call: (args: string[]) => Promise<any>): Promise<any> {
  const plan = r.tierLaunch, db = opts.tier?.db;
  if ("error" in r) {
    if (plan && db) fact("拒绝的启动", () => { recordLaunchAttempt(db, plan); recordLaunchFailed(db, plan, r.error); });
    return { ok: false, error: r.error };
  }
  if (plan && db) fact("启动尝试", () => recordLaunchAttempt(db, plan));
  let res: any;
  try { res = await call(r.args); } catch (e) {
    // 抛错时 create 有没有发到 manager 说不准：记 failed（结果不明 + 原因）收住这次尝试，免得之后按 agent 名绑到别的会话；异常照旧往上抛
    if (plan && db) fact("启动异常", () => recordLaunchFailed(db, plan, `create 抛错，结果不明：${(e as Error)?.message ?? String(e)}`.slice(0, 300)));
    throw e;
  }
  if (plan && db && res?.ok !== true) fact("启动失败", () => recordLaunchFailed(db, plan, String(res?.error ?? "create 没有成功").slice(0, 300)));
  return res;
}

/** 变参 manager（scheduler-auto-deps / scheduler-local-author 的 env.create）外包一层：坏定义就不调 create */
export function cardRoleCreate<T extends Create>(create: T, opts: CardRoleOptions = {}): T {
  return (async (...args: string[]) => launchRecorded(applyCardRole(args, opts), opts, (a) => create(...a))) as T;
}

/**
 * 不加载角色定义、只做类型模型选择的一层（审查换会话那条 create 原本就不带角色定义，不在这里改它的边界）。off / observe 原样放行。
 */
export function tierCreate<T extends Create>(create: T, ctx: TierLaunchCtx, role: CardRole): T {
  return (async (...args: string[]) => launchRecorded(tierOnly(args, ctx, role), { tier: ctx }, (a) => create(...a))) as T;
}

function tierOnly(args: string[], ctx: TierLaunchCtx, role: CardRole): Applied {
  if (args[0] !== "create") return { args };
  if (flagValue(args, "--runtime")?.value === "codex") return codexTier(args, role, ctx) ?? { args };
  const model = flagValue(args, "--model")?.value ?? null;
  const d = decideTierLaunch(ctx, role, "claude", model, args[1] ?? null);
  if ("error" in d) return { error: `${role}：${d.error}；没有建会话`, tierLaunch: d.plan };
  if (d.mode !== "on") return { args };
  const dup = repeatedFlag(args);
  if (dup) return { error: `${role}：${dup}；没有建会话`, tierLaunch: d.plan };
  const out = model === null && d.value ? [...args, "--model", d.value] : args;
  d.plan.final.model = flagValue(out, "--model")?.value ?? null;
  return { args: out, tierLaunch: d.plan };
}

/** StepIO.manager（start_node 的 runStart）外包一层，语义同 cardRoleCreate */
export function cardRoleManager<T extends (args: string[], timeoutMs?: number) => Promise<any>>(manager: T, opts: CardRoleOptions = {}): T {
  return (async (args: string[], timeoutMs?: number) => launchRecorded(applyCardRole(args, opts), opts, (a) => manager(a, timeoutMs))) as T;
}

/** runLocalStart 的 io：manager 每次现取调用方 io 上的那个（排队重试时调用方换过 manager 也照用新的），其余字段照抄 */
export function cardRoleIo<T extends { manager: (args: string[], timeoutMs?: number) => Promise<any> }>(io: T, opts: CardRoleOptions = {}): T {
  return { ...io, manager: cardRoleManager((args: string[], timeoutMs?: number) => io.manager(args, timeoutMs), opts) };
}
