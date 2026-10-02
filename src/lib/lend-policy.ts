/**
 * lend.json 的准入规则（docs/design/remote-capacity.md §1）：对象只能是 peers.json 里已握手、未禁用的联系人；个人项目永远不进 borrow。
 * 写入时（buildGrant / buildBorrowEntry）拦一道，读取时（effectiveLend）再按当下的 peers / projects 与授权规则核一遍——
 * peer 后来被删、被禁用、换了实例（指纹对不上），或项目后来被标成个人项目，那一条当场失效，不用等人去改 lend.json。
 * 除 readLendContext 外都是纯函数：peers 与 projects 由调用方读好传进来。tests/lend-config.test.ts。
 */
import {
  DEFAULT_MAX_OPEN, DEFAULT_ORDERS_PER_DAY, LEND_FAMILIES, LEND_ROLES, MAX_FAMILY_SLOTS, MAX_OPEN, MAX_ORDERS_PER_DAY, MAX_REPOS, REPO_RE,
  type BorrowEntry, type LendEntry, type LendFamily, type LendRead, type LendRole,
} from "./lend-config.js";
import { GRANT_MAX_DAYS, GRANT_MAX_MS, grantProblem } from "./lend-grant-rules.js";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { readPeers } from "./peers.js";
import { isUmbrellaDir, normalizeDir, readProjects, type ProjectDef } from "./projects.js";

/** peers.json 里 httpPeers 的这几个字段就够认人（不碰 token） */
export interface LendContact { name: string; fp?: string; disabled?: boolean }

export type Built<T> = { ok: true; entry: T } | { ok: false; error: string };

const realOrNull = (d: string): string | null => {
  try { return realpathSync(d); } catch { return null; /* 不存在 / 没权限：调用方按个人项目处理（fail-closed） */ }
};

/** 伞形根（家目录 / 根 / 系统临时目录）的字面路径与真实路径；只做精确匹配，HOME/repos/x 这类子目录不算 */
function umbrellaRoots(): Set<string> {
  const out = new Set<string>();
  for (const d of ["/", process.env.HOME || homedir(), homedir(), "/tmp", "/private/tmp", "/var/tmp", tmpdir()]) {
    out.add(normalizeDir(d));
    const r = realOrNull(d);
    if (r) out.add(r);
  }
  return out;
}

/**
 * 个人项目：显式标了 personal，或者某个目录解析到伞形根（「家目录杂项」这种项目什么都可能装）。
 * 按真实路径比：软链别名（~/home-alias → ~）也要认出来；解析不了、不是绝对路径的目录一律按个人项目处理。
 */
export function isPersonalProject(p: Pick<ProjectDef, "dirs"> & { personal?: boolean }): boolean {
  if (p.personal === true) return true;
  const roots = umbrellaRoots();
  return p.dirs.some((raw) => {
    const d = normalizeDir(raw);
    if (!d.startsWith("/") || isUmbrellaDir(d)) return true;
    const real = realOrNull(d);
    return real === null || roots.has(real);
  });
}

/** 按名字或指纹找一个未禁用的联系人；两种都对不上 / 指纹同时对上多条 → 报错 */
export function resolveContact(contacts: readonly LendContact[], ref: string): Built<{ peer: string; fp?: string }> {
  const live = contacts.filter((c) => !c.disabled);
  const byName = live.find((c) => c.name === ref);
  if (byName) return { ok: true, entry: { peer: byName.name, ...(byName.fp ? { fp: byName.fp.toLowerCase() } : {}) } };
  const want = ref.toLowerCase();
  const byFp = live.filter((c) => c.fp?.toLowerCase() === want);
  if (byFp.length === 1) return { ok: true, entry: { peer: byFp[0].name, fp: want } };
  if (byFp.length > 1) return { ok: false, error: `指纹 ${ref} 对上了 ${byFp.length} 个 peer（${byFp.map((c) => c.name).join("、")}），请改用 peer 名` };
  const disabled = contacts.some((c) => c.disabled && (c.name === ref || c.fp?.toLowerCase() === want));
  return { ok: false, error: disabled ? `peer ${ref} 已被禁用，不能作为出借 / 借入对象` : `peer ${ref} 不在联系人里（manager peer-http-list 看已握手的 peer）` };
}

/** 已写进文件的条目是否仍指向同一个联系人：名字在、没禁用、记下的指纹与现在的一致 */
function contactProblem(contacts: readonly LendContact[], e: { peer: string; fp?: string }): string | null {
  const c = contacts.find((x) => x.name === e.peer);
  if (!c) return `peer ${e.peer} 已不在联系人里`;
  if (c.disabled) return `peer ${e.peer} 已被禁用`;
  if (e.fp && c.fp?.toLowerCase() !== e.fp) return `peer ${e.peer} 的实例指纹变了（记的是 ${e.fp}），要重新 set 确认`;
  return null;
}

const splitList = (s: string | undefined): string[] => [...new Set((s ?? "").split(",").map((x) => x.trim()).filter(Boolean))];

function parseCount(raw: string | undefined, label: string, min: number, max: number, dflt: number): number | string {
  if (raw === undefined) return dflt;
  const n = /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return n >= min && n <= max ? n : `${label} 要是 ${min}..${max} 的整数（收到 ${raw}）`;
}

/**
 * 借入条目的角色解析；出借不再区分角色，旧 --roles 输入由 buildGrant 忽略。
 */
function parseRoles(raw: string | undefined): LendRole[] | string {
  const roles = raw === undefined ? ["review"] : splitList(raw);
  if (roles.length === 0) return "--roles 不能为空";
  const bad = roles.find((r) => r !== "review" && r !== "write");
  if (bad) return `--roles 只认 review / write（不认识 ${bad}）`;
  return roles as LendRole[];
}

/** 一次授权的缺省（He 10-01 拍板）：只出 codex 5 个位、每天 200 单；到期时间必填、最长 7 天 */
const DEFAULT_GRANT_FAMILIES: Partial<Record<LendFamily, number>> = { codex: 5 };

export interface LendGrantInput {
  ref: string;
  families: Partial<Record<LendFamily, string>>;
  roles?: string;
  repos?: string;
  ordersPerDay?: string;
  /** ISO 时间，或相对时长 Nd / Nh */
  until?: string;
}

function parseUntil(raw: string | undefined, now: number): number | string {
  if (raw === undefined) return `要写到期时间：--until <ISO 时间> 或 --until 3d（最长 ${GRANT_MAX_DAYS} 天）`;
  const rel = /^(\d{1,4})([dh])$/.exec(raw.trim());
  const t = rel ? now + Number(rel[1]) * (rel[2] === "d" ? 86_400_000 : 3_600_000) : /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isNaN(t) || t <= now) return `--until 要是未来的 ISO 时间或 Nd / Nh：${raw}`;
  return t - now > GRANT_MAX_MS ? `--until 最长 ${GRANT_MAX_DAYS} 天（收到 ${raw}）` : t;
}

export function buildGrant(input: LendGrantInput, contacts: readonly LendContact[], now = Date.now()): Built<LendEntry> {
  const who = resolveContact(contacts, input.ref);
  if (!who.ok) return who;
  if (!who.entry.fp) return { ok: false, error: `peer ${who.entry.peer} 没有实例指纹（旧版握手），授权要钉指纹：重新配对后再授权` };
  const given = LEND_FAMILIES.filter((f) => input.families[f] !== undefined);
  const families: Partial<Record<LendFamily, number>> = given.length ? {} : { ...DEFAULT_GRANT_FAMILIES };
  for (const f of given) {
    const n = parseCount(input.families[f], `--${f}`, 0, MAX_FAMILY_SLOTS, 0);
    if (typeof n === "string") return { ok: false, error: n };
    families[f] = n;
  }
  if (!Object.values(families).some((n) => n! > 0)) return { ok: false, error: "至少给一个家族出位：--codex N 或 --claude N（N ≥ 1）" };
  const repos = splitList(input.repos);
  if (repos.length === 0) return { ok: false, error: "要列出仓库白名单：--repos owner/repo[,owner/repo]" };
  if (repos.length > MAX_REPOS) return { ok: false, error: `仓库最多 ${MAX_REPOS} 个` };
  const badRepo = repos.find((r) => !REPO_RE.test(r));
  if (badRepo) return { ok: false, error: `仓库要写成 GitHub 的 owner/repo：${badRepo}` };
  const perDay = parseCount(input.ordersPerDay, "--orders-per-day", 1, MAX_ORDERS_PER_DAY, DEFAULT_ORDERS_PER_DAY);
  if (typeof perDay === "string") return { ok: false, error: perDay };
  const until = parseUntil(input.until, now);
  if (typeof until === "string") return { ok: false, error: until };
  return {
    ok: true,
    entry: { ...who.entry, families, roles: [...LEND_ROLES], repos, ordersPerDay: perDay, until: new Date(until).toISOString(), grantedAt: new Date(now).toISOString() },
  };
}

export interface BorrowSetInput { ref: string; projects?: string; roles?: string; maxOpen?: string }

export function buildBorrowEntry(
  input: BorrowSetInput, contacts: readonly LendContact[], projects: readonly (ProjectDef & { personal?: boolean })[],
): Built<BorrowEntry> {
  const who = resolveContact(contacts, input.ref);
  if (!who.ok) return who;
  const ids = splitList(input.projects);
  if (ids.length === 0) return { ok: false, error: "要列出可以外借的项目：--projects <id,id>" };
  for (const id of ids) {
    const p = projects.find((x) => x.id === id);
    if (!p) return { ok: false, error: `项目 ${id} 不存在（manager project-list 看项目 id）` };
    if (isPersonalProject(p)) return { ok: false, error: `项目 ${id} 是个人项目，永远不外借（标了 personal，或目录是家目录 / 临时目录 / 它们的别名，或目录解析不了）` };
  }
  const roles = parseRoles(input.roles);
  if (typeof roles === "string") return { ok: false, error: roles };
  const maxOpen = parseCount(input.maxOpen, "--max-open", 1, MAX_OPEN, DEFAULT_MAX_OPEN);
  if (typeof maxOpen === "string") return { ok: false, error: maxOpen };
  return { ok: true, entry: { ...who.entry, projects: ids, roles, maxOpen } };
}

export interface EffectiveLend {
  /** 出借是否实际生效（文件有效、enabled=true、至少一条条目还有效） */
  lending: boolean;
  lend: LendEntry[];
  borrow: BorrowEntry[];
  /** 文件无效的原因（此时 lend / borrow 都是空） */
  invalid?: string;
  /** 失效的条目 / 项目及原因（给 doctor 与 status 显示） */
  dropped: string[];
}

/**
 * 实际生效的声明：文件无效 = 全关；enabled=false = 不出借；每条授权再按当下的联系人（指纹）与 grantProblem（暂停 / 到期 / 期限）过滤，
 * 借入按个人项目过滤。
 */
export function effectiveLend(
  read: LendRead, contacts: readonly LendContact[], projects: readonly (ProjectDef & { personal?: boolean })[], now = Date.now(),
): EffectiveLend {
  if (read.status === "invalid") return { lending: false, lend: [], borrow: [], invalid: read.error, dropped: [] };
  const f = read.file;
  const dropped: string[] = [];
  const lend: LendEntry[] = [];
  if (f.enabled === true) {
    for (const e of f.lend) {
      const bad = grantProblem(e, now) ?? contactProblem(contacts, e);
      if (bad) dropped.push(`lend ${e.peer}：${bad}`);
      else lend.push(e);
    }
  }
  const borrow: BorrowEntry[] = [];
  for (const e of f.borrow) {
    const bad = contactProblem(contacts, e);
    if (bad) { dropped.push(`borrow ${e.peer}：${bad}`); continue; }
    const ok = e.projects.filter((id) => {
      const p = projects.find((x) => x.id === id);
      const why = !p ? "项目已不存在" : isPersonalProject(p) ? "是个人项目（或目录解析不了）" : null;
      if (why) dropped.push(`borrow ${e.peer} / ${id}：${why}`);
      return !why;
    });
    if (ok.length) borrow.push({ ...e, projects: ok });
  }
  return { lending: lend.length > 0, lend, borrow, dropped };
}

/** 读当下的联系人与项目。peers.json 只取名字 / 指纹 / 禁用位，token 不出这个函数 */
export async function readLendContext(): Promise<{ contacts: LendContact[]; projects: ProjectDef[] }> {
  const [peers, { projects }] = await Promise.all([readPeers(), readProjects()]);
  const contacts = (peers.httpPeers ?? []).map((p) => ({ name: p.name, ...(p.fp ? { fp: p.fp } : {}), ...(p.disabled ? { disabled: true } : {}) }));
  return { contacts, projects };
}
