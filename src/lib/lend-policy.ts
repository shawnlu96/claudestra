/**
 * lend.json 的准入规则（docs/design/remote-capacity.md §1）：对象只能是 peers.json 里已握手、未禁用的联系人；个人项目永远不进 borrow。
 * 写入时（buildLendEntry / buildBorrowEntry）拦一道，读取时（effectiveLend）再按当下的 peers / projects 核一遍——
 * peer 后来被删、被禁用、换了实例（指纹对不上），或项目后来被标成个人项目，那一条当场失效，不用等人去改 lend.json。
 * 除 readLendContext 外都是纯函数：peers 与 projects 由调用方读好传进来。tests/lend-config.test.ts。
 */
import {
  DEFAULT_MAX_OPEN, DEFAULT_ORDERS_PER_DAY, LEND_FAMILIES, MAX_FAMILY_SLOTS, MAX_OPEN, MAX_ORDERS_PER_DAY, MAX_REPOS, REPO_RE,
  type BorrowEntry, type LendConfirm, type LendEntry, type LendFamily, type LendRead, type LendRole,
} from "./lend-config.js";
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
 * review = 审查单；write = 开工 / 修复单（i28-R6：出借方在借入方仓库的 lend/ 分支上写代码、推送、开 PR）。缺省只开 review，
 * write 要明确写出来：它会用出借人自己的 GitHub 登录推送。
 */
function parseRoles(raw: string | undefined): LendRole[] | string {
  const roles = raw === undefined ? ["review"] : splitList(raw);
  if (roles.length === 0) return "--roles 不能为空";
  const bad = roles.find((r) => r !== "review" && r !== "write");
  return bad ? `--roles 只认 review / write（不认识 ${bad}）` : (roles as LendRole[]);
}

export interface LendSetInput {
  ref: string;
  families: Partial<Record<LendFamily, string>>;
  roles?: string;
  repos?: string;
  ordersPerDay?: string;
  confirm?: string;
  until?: string;
}

export function buildLendEntry(input: LendSetInput, contacts: readonly LendContact[], now = Date.now()): Built<LendEntry> {
  const who = resolveContact(contacts, input.ref);
  if (!who.ok) return who;
  const families: Partial<Record<LendFamily, number>> = {};
  for (const f of LEND_FAMILIES) {
    if (input.families[f] === undefined) continue;
    const n = parseCount(input.families[f], `--${f}`, 0, MAX_FAMILY_SLOTS, 0);
    if (typeof n === "string") return { ok: false, error: n };
    families[f] = n;
  }
  if (!Object.values(families).some((n) => n! > 0)) return { ok: false, error: "至少给一个家族出位：--codex N 或 --claude N（N ≥ 1）" };
  const roles = parseRoles(input.roles);
  if (typeof roles === "string") return { ok: false, error: roles };
  const repos = splitList(input.repos);
  if (repos.length === 0) return { ok: false, error: "要列出仓库白名单：--repos owner/repo[,owner/repo]" };
  if (repos.length > MAX_REPOS) return { ok: false, error: `仓库最多 ${MAX_REPOS} 个` };
  const badRepo = repos.find((r) => !REPO_RE.test(r));
  if (badRepo) return { ok: false, error: `仓库要写成 GitHub 的 owner/repo：${badRepo}` };
  const perDay = parseCount(input.ordersPerDay, "--orders-per-day", 1, MAX_ORDERS_PER_DAY, DEFAULT_ORDERS_PER_DAY);
  if (typeof perDay === "string") return { ok: false, error: perDay };
  const confirm = (input.confirm ?? "per-order") as LendConfirm;
  if (confirm !== "per-order" && confirm !== "auto") return { ok: false, error: "--confirm 只能是 per-order（缺省，逐单确认）或 auto" };
  let until: string | undefined;
  if (input.until !== undefined) {
    const t = Date.parse(input.until);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(input.until) || Number.isNaN(t) || t <= now) return { ok: false, error: `--until 要是未来的 ISO 时间：${input.until}` };
    until = new Date(t).toISOString();
  }
  if (confirm === "auto" && !until) return { ok: false, error: "--confirm auto（预先授权）必须带 --until：不许无限期免确认" };
  return {
    ok: true,
    entry: { ...who.entry, families, roles, repos, quota: { ordersPerDay: perDay, tokensPerDay: null }, confirm, ...(until ? { until } : {}) },
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
 * 限时预先授权（confirm auto）此刻还算不算数：必须写了 until 且没到；到期或没写一律退回逐单确认（条目本身照常出借）。
 * 当天单数由 quota.ordersPerDay 硬卡（用完当天不再接单），不在这里判。tests/lend-preauth.test.ts。
 */
function preauthProblem(e: LendEntry, now: number): string | null {
  if (e.confirm !== "auto") return null;
  if (!e.until) return "没写到期时间";
  return Date.parse(e.until) <= now ? `已于 ${e.until} 到期` : null;
}

function perOrder(e: LendEntry): LendEntry {
  const out: LendEntry = { ...e, confirm: "per-order" };
  delete out.until;
  return out;
}

/** 实际生效的声明：文件无效 = 全关；enabled=false = 不出借；每条再按当下的联系人、到期时间、个人项目过滤 */
export function effectiveLend(
  read: LendRead, contacts: readonly LendContact[], projects: readonly (ProjectDef & { personal?: boolean })[], now = Date.now(),
): EffectiveLend {
  if (read.status === "invalid") return { lending: false, lend: [], borrow: [], invalid: read.error, dropped: [] };
  const f = read.file;
  const dropped: string[] = [];
  const lend: LendEntry[] = [];
  if (f.enabled === true) {
    for (const e of f.lend) {
      const bad = contactProblem(contacts, e) ?? (e.confirm !== "auto" && e.until && Date.parse(e.until) <= now ? `出借给 ${e.peer} 已于 ${e.until} 到期` : null);
      if (bad) { dropped.push(`lend ${e.peer}：${bad}`); continue; }
      const pre = preauthProblem(e, now);
      if (pre) dropped.push(`lend ${e.peer} 的预先授权：${pre}，按逐单确认`);
      lend.push(pre ? perOrder(e) : e); // auto 的 until 只是预先授权的期限，退回逐单确认后不再当出借期限
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
