/**
 * 角色 × 家族的模型档位表（TIER1）：Claude 列是模型 id，Codex 列是推理档（null = 照 Codex 自己的配置，不传 --effort）。
 * 默认表就在这里、随版本发布：四个卡片角色 Claude 全是 CARD_DEFAULT_MODEL（Opus 5.5），Codex 全是 null——不按 diff / 安全面 / 用途自动降档。
 * owner 在网页改的值存在 statePath("role-model-settings.json")；读分 missing / ok / invalid（内容不合法）/ unreadable（读不了），
 * 后两种都按默认表执行并如实标出。写只经 saveRoleModels：锁 + 锁内现读 + rev CAS + 校验 + 原子写；读不了的文件不写（不知道上面是什么），
 * 内容坏了先另存 `.invalid-<ts>` 再以默认表为底写入。值要换生效得经 RecoveryPolicyPort 的 roleModel 键（role-model-settings-local.ts）。
 * tests/role-model-settings.test.ts。
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { CODEX_EFFORT_LEVELS } from "./codex-launch.js";
import { acquireLock } from "./file-lock.js";
import { isCodexModel } from "./lend-config.js";
import { statePath } from "./paths.js";
import { writeJsonAtomicSync } from "./state-file.js";

/** 本机卡片角色（card-role-definitions.ts 原样 re-export）：表的行就是它们，放这里免得两个模块互相 import */
export const CARD_ROLES = ["author", "reviewer", "adversarial-reviewer", "pm-reviewer"] as const;
export type CardRole = (typeof CARD_ROLES)[number];
/** 本机 Claude 卡片角色的缺省模型：默认表的 Claude 列，每个角色定义文件里写的也是它 */
export const CARD_DEFAULT_MODEL = "claude-opus-5-5";
export const ROLE_MODEL_SETTINGS_PATH = statePath("role-model-settings.json");
export const ROLE_MODEL_FAMILIES = ["claude", "codex"] as const;
export type RoleModelFamily = (typeof ROLE_MODEL_FAMILIES)[number];
type CodexEffort = (typeof CODEX_EFFORT_LEVELS)[number];

/** 一个角色的一行：claude = 完整模型 id；codex = 推理档，null = 照 Codex 自己的配置 */
export interface RoleModelCell { claude: string; codex: CodexEffort | null }
export interface RoleModelTable { v: 1; rev: number; roles: Record<CardRole, RoleModelCell> }
export type RoleModelRead =
  | { status: "missing" | "ok"; table: RoleModelTable }
  /** error 是本机原因（可能带路径），只进本机日志；table 是这时实际执行的默认表 */
  | { status: "invalid" | "unreadable"; error: string; table: RoleModelTable };

export const defaultRoleModels = (): RoleModelTable => ({
  v: 1, rev: 0, roles: Object.fromEntries(CARD_ROLES.map((r) => [r, { claude: CARD_DEFAULT_MODEL, codex: null }])) as Record<CardRole, RoleModelCell>,
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const extra = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).find((k) => !keys.includes(k));
const isClaudeModelId = (v: unknown): v is string => typeof v === "string" && /^claude-[a-z0-9][a-z0-9.-]*$/.test(v) && isCodexModel(v);
const isCodexEffortLevel = (v: unknown): v is CodexEffort => CODEX_EFFORT_LEVELS.includes(v as CodexEffort);
export const isCardRoleName = (v: unknown): v is CardRole => CARD_ROLES.includes(v as CardRole);

function cellProblem(v: unknown, where: string): string | null {
  if (!isObj(v)) return `${where} 要是对象`;
  const x = extra(v, ROLE_MODEL_FAMILIES);
  if (x !== undefined) return `${where} 不认识的字段 ${x}`;
  if (!isClaudeModelId(v.claude)) return `${where}.claude 要是完整的 Claude 模型 id`;
  if (v.codex !== null && !isCodexEffortLevel(v.codex)) return `${where}.codex 要是 null 或 ${CODEX_EFFORT_LEVELS.join(" / ")}`;
  return null;
}

/** 整表校验；缺任何一个角色也算坏：缺的不能静默套默认，否则网页显示的和执行的会分叉 */
export function roleModelsProblem(v: unknown): string | null {
  if (!isObj(v)) return "不是 JSON 对象";
  const x = extra(v, ["v", "rev", "roles"]);
  if (x !== undefined) return `不认识的字段 ${x}`;
  if (v.v !== 1) return "v 要是 1";
  if (!Number.isSafeInteger(v.rev) || (v.rev as number) < 0) return "rev 要是非负整数";
  if (!isObj(v.roles)) return "roles 要是对象";
  const rx = extra(v.roles, CARD_ROLES);
  if (rx !== undefined) return `不认识的角色 ${rx}`;
  for (const r of CARD_ROLES) {
    const p = v.roles[r] === undefined ? `缺角色 ${r}` : cellProblem(v.roles[r], `roles.${r}`);
    if (p) return p;
  }
  return null;
}

/** 每次现读，不缓存：网页刚存的值下一次建卡就看得到 */
export function readRoleModels(path = ROLE_MODEL_SETTINGS_PATH): RoleModelRead {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", table: defaultRoleModels() };
    return { status: "unreadable", error: `读不了 ${path}：${(e as Error).message}`, table: defaultRoleModels() };
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch (e) { return { status: "invalid", error: `JSON 解析失败：${(e as Error).message}`, table: defaultRoleModels() }; }
  const p = roleModelsProblem(data);
  return p ? { status: "invalid", error: p, table: defaultRoleModels() } : { status: "ok", table: data as RoleModelTable };
}

/** 网页的一次修改：基于哪一版（rev，CAS）、哪个角色、改哪一格；整份拒，不部分更新 */
export interface RoleModelPatch { rev: number; role: CardRole; claude?: string; codex?: CodexEffort | null }

export function parseRoleModelPatch(b: unknown): RoleModelPatch | string {
  if (!isObj(b)) return "请求体要是 JSON 对象";
  const x = extra(b, ["rev", "role", "claude", "codex"]);
  if (x !== undefined) return `不认识的字段 ${x}`;
  if (!Number.isSafeInteger(b.rev) || (b.rev as number) < 0) return "rev 要是非负整数（读到的那一版）";
  if (!isCardRoleName(b.role)) return `role 只认 ${CARD_ROLES.join(" / ")}`;
  if (b.claude === undefined && b.codex === undefined) return "没有要改的：给 claude 或 codex";
  if (b.claude !== undefined && !isClaudeModelId(b.claude)) return "claude 要是完整的 Claude 模型 id（claude-…）";
  if (b.codex !== undefined && b.codex !== null && !isCodexEffortLevel(b.codex)) return `codex 只认 null（照 Codex 配置）或 ${CODEX_EFFORT_LEVELS.join(" / ")}`;
  return { rev: b.rev as number, role: b.role, ...(b.claude !== undefined ? { claude: b.claude as string } : {}),
    ...(b.codex !== undefined ? { codex: b.codex as CodexEffort | null } : {}) };
}

export type RoleModelSave =
  | { ok: true; table: RoleModelTable; replacedInvalid: string | null }
  | { ok: false; code: "busy" | "conflict" | "unreadable" | "io"; error: string; current?: RoleModelTable };
const LOCK_WAIT_MS = 5_000;
/** 测试缝：beforeCommit 在 rename 前、核锁前同步调用（模拟写者恰在提交前被暂停） */
export interface SaveHooks { beforeCommit?: () => void }

/**
 * 唯一写入口。rev 不是现在这一版 = conflict（带回现值，网页按它刷新再改），不覆盖别人刚存的；读不了 = 不写。
 * 写失败一律 ok:false，调用方不能报「已保存」。
 */
export async function saveRoleModels(p: RoleModelPatch, path = ROLE_MODEL_SETTINGS_PATH, now = Date.now(), hooks: SaveHooks = {}): Promise<RoleModelSave> {
  let lost = false;
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try { lock = await acquireLock(`${path}.lock`, LOCK_WAIT_MS); } catch (e) { return { ok: false, code: "io", error: `拿模型档位表的锁失败：${(e as Error).message}` }; }
  if (!lock) return { ok: false, code: "busy", error: "模型档位表正被别的请求修改，稍后再试" };
  try {
    const cur = readRoleModels(path);
    if (cur.status === "unreadable") return { ok: false, code: "unreadable", error: cur.error };
    if (cur.table.rev !== p.rev) return { ok: false, code: "conflict", error: `基于第 ${p.rev} 版改，现在已是第 ${cur.table.rev} 版`, current: cur.table };
    const row = cur.table.roles[p.role];
    const table: RoleModelTable = { v: 1, rev: cur.table.rev + 1,
      roles: { ...cur.table.roles, [p.role]: { claude: p.claude ?? row.claude, codex: p.codex === undefined ? row.codex : p.codex } } };
    const bad = roleModelsProblem(table);
    if (bad) return { ok: false, code: "io", error: `合并后的表不合法：${bad}` };
    if (cur.status === "invalid" && existsSync(path)) copyFileSync(path, `${path}.invalid-${now}`);
    // 拿锁之后全程同步、没有 await；锁在 rename 前一刻经 commitIf 再核（被暂停超期、锁被别人回收的写者在这里被拦下，不覆盖后来者）
    writeJsonAtomicSync(path, table, { mode: 0o600, trailingNewline: true, commitIf: () => {
      hooks.beforeCommit?.();
      return lock.held() || ((lost = true), false);
    } });
    return { ok: true, table, replacedInvalid: cur.status === "invalid" ? cur.error : null };
  } catch (e) {
    if (lost) return { ok: false, code: "busy", error: "模型档位表的锁已失效（被当过期回收），没写入" };
    return { ok: false, code: "io", error: `写模型档位表失败：${(e as Error).message}` };
  } finally {
    lock.release();
  }
}

/** 这个角色在这个家族的表值与来源：settings = owner 存过且文件有效；default = 没存过；error = 文件坏 / 读不了，按默认表 */
export function roleModelOf(read: RoleModelRead, role: CardRole, family: RoleModelFamily): { value: string | null; source: "settings" | "default" | "error" } {
  const value = read.table.roles[role][family];
  return { value, source: read.status === "ok" ? "settings" : read.status === "missing" ? "default" : "error" };
}
