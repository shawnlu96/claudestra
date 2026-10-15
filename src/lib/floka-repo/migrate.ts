/**
 * rename.repo:GitHub 仓库转移后,把本地 checkout 的 origin 从旧官方地址迁到新地址;回滚把记录下的原值放回。
 * - 只迁 origin,且只迁精确等于旧官方地址(url.ts 四种形状)的值;SSH / HTTPS、端口、.git 后缀原样保留。
 *   fork、额外 remote、自定义 / 带凭据的地址一律不动,列进 untouched。
 * - off 一次 Git 调用都没有;observe 只读(listRemotes),出计划与转移先决条件;on 先核 remote 指纹与 observe 时一致才写。
 * - 写之前先把原值落进迁移记录;回滚只按记录恢复,当前值不是本工具写的就拒绝覆盖。
 * - 本地回滚只恢复本地 remote,GitHub 上的转移不会因此撤销(结果里 githubUntouched 恒为 true)。
 */

import { createHash } from "node:crypto";
import { parseTxMode } from "../floka-migration/transaction/executor.ts";
import { isOfficialUrl, isSlug, rewriteOfficialUrl } from "./url.ts";
import type {
  MigrationRecord, Prerequisite, RecordStore, RemoteEntry, RepoGit, RepoMode, RepoPlan, RepoResult, Untouched, UrlChange, UrlKey,
} from "./types.ts";

export const REPO_ITEM = "rename.repo";
/** 现在的官方仓库 */
export const OFFICIAL_REPO = "shawnlu96/claudestra";
/** 建议目标(PM 定,owner 另批);与私仓 floka-ai/cloud 分开 */
export const PROPOSED_REPO = "floka-ai/floka";
/** N7C 私仓:公共仓不能转进 / 并进它 */
export const PRIVATE_CLOUD_REPO = "floka-ai/cloud";
/** install.sh 的 CLAUDESTRA_REPO 缺省值;tests/floka-repo.test.ts 逐字核两边一致 */
export const installDefaultUrl = (slug = OFFICIAL_REPO): string => `https://github.com/${slug}.git`;

const repoMode = (raw: unknown): RepoMode => parseTxMode(raw);

/** 转移前要人逐项核的 GitHub 侧设施(详见 scripts/rename-floka/repo-checklist.md),本工具不连 GitHub、不代核 */
const PREREQUISITES: readonly Prerequisite[] = [
  { id: "org.permissions", check: "目标组织存在,转移人在源仓 admin、在目标组织有建仓权限;成员 / team 权限在新组织重新授予", status: "manual" },
  { id: "org.separate-cloud", check: `目标是独立新仓(建议 ${PROPOSED_REPO}),不是 ${PRIVATE_CLOUD_REPO},也不并入它;私仓闭包 pin 另核`, status: "manual" },
  { id: "apps.integrations", check: "已装的 GitHub App / OAuth App / webhook 在目标组织重新安装授权并核回调", status: "manual" },
  { id: "actions.secrets-runners", check: "仓库 / 组织 secrets、variables、environments、自托管 runner 组在新组织可用", status: "manual" },
  { id: "branch.protection", check: "分支保护 / ruleset、必过检查、CODEOWNERS 在转移后逐条核对", status: "manual" },
  { id: "deploy.permissions", check: "deploy key、部署权限、GITHUB_TOKEN 权限设置与 environments 审批人", status: "manual" },
  { id: "pages.actions-refs", check: "Pages 域名、workflow 里写死的 owner/repo、uses: 引用、raw.githubusercontent 安装链接", status: "manual" },
  { id: "releases.tags", check: "tag / Release 随仓转移;此后每次 tag / Release 仍由 owner 单独审批", status: "manual" },
  { id: "old-name.squat", check: "旧名被重新占用(同名新仓 / fork)会让重定向失效:转移后保留占位或监控旧名", status: "manual" },
  { id: "redirect.not-guarantee", check: "仓库重定向只覆盖 git / 网页 / API 地址,不等于发布设施(安装脚本、Pages、App、runner)都已迁好", status: "manual" },
];

const keyOf = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** 计划身份;on 时也用它核交回来的计划没被改过 */
const planKeyOf = (p: Pick<RepoPlan, "sourceKey" | "from" | "to" | "changes">): string =>
  keyOf({ sourceKey: p.sourceKey, from: p.from, to: p.to, changes: p.changes });

const normalize = (remotes: readonly RemoteEntry[]): RemoteEntry[] =>
  [...remotes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((r) => ({ name: r.name, urls: [...r.urls], pushUrls: [...r.pushUrls] }));

/** remote 全集的指纹:名字、每个值的原文与顺序 */
const remotesKey = (remotes: readonly RemoteEntry[]): string => keyOf(normalize(remotes));

function targetRefusals(from: string, to: string): string[] {
  const out: string[] = [];
  if (!isSlug(from)) out.push(`源仓库 ${JSON.stringify(from)} 不是 owner/repo`);
  if (!isSlug(to)) out.push(`目标仓库 ${JSON.stringify(to)} 不是 owner/repo`);
  if (from.toLowerCase() === to.toLowerCase()) out.push("目标与源是同一个仓库");
  if (to.toLowerCase() === PRIVATE_CLOUD_REPO) out.push(`目标不能是私仓 ${PRIVATE_CLOUD_REPO}:公共仓要转到独立的新仓库,不并进 cloud`);
  return out;
}

/** 纯函数:由 remote 原值算出计划。只有 origin 上精确等于旧官方地址的值进 changes */
export function buildRepoPlan(remotes: readonly RemoteEntry[], from = OFFICIAL_REPO, to = PROPOSED_REPO): RepoPlan {
  const list = normalize(remotes);
  const refusals = targetRefusals(from, to);
  const changes: UrlChange[] = [];
  const untouched: Untouched[] = [];
  const valid = refusals.length === 0;
  for (const r of list) {
    for (const key of ["url", "pushurl"] as UrlKey[]) {
      const values = key === "url" ? r.urls : r.pushUrls;
      for (const url of values) {
        const official = valid && isOfficialUrl(url, from);
        if (official && r.name === "origin" && values.length === 1) {
          changes.push({ remote: r.name, key, from: url, to: rewriteOfficialUrl(url, from, to)! });
          continue;
        }
        let reason: string;
        if (official && r.name === "origin") {
          reason = `origin 的 ${key} 有 ${values.length} 个值,不猜改哪个`;
          const msg = `origin.${key} 有多个值(${values.length}),先手工整理成一个再迁`;
          if (!refusals.includes(msg)) refusals.push(msg);
        } else if (official) reason = "不是 origin:额外 remote 不动";
        else if (valid && isOfficialUrl(url, to)) reason = "已是目标地址";
        else reason = "不是旧官方地址(fork / 自定义 / 带凭据 / 非 GitHub):不动";
        untouched.push({ remote: r.name, key, url, reason });
      }
    }
  }
  const sourceKey = remotesKey(list);
  return {
    version: 1, item: REPO_ITEM, from, to, sourceKey, planKey: planKeyOf({ sourceKey, from, to, changes }),
    remotes: list, changes, untouched, prerequisites: PREREQUISITES, refusals,
  };
}

const result = (mode: RepoMode, status: RepoResult["status"], extra: Partial<RepoResult> = {}): RepoResult =>
  ({ item: REPO_ITEM, mode, status, refusals: [], githubUntouched: true, ...extra });

export interface PlanInput {
  mode: unknown;
  git: RepoGit;
  from?: string;
  to?: string;
}

/** off:不调 git;observe / on:只读出计划 */
export async function planRepoMigration(input: PlanInput): Promise<RepoResult> {
  const mode = repoMode(input.mode);
  if (mode === "off") return result(mode, "off");
  const plan = buildRepoPlan(await input.git.listRemotes(), input.from, input.to);
  return result(mode, "observed", { plan, refusals: plan.refusals });
}

function asPlan(raw: unknown): RepoPlan | null {
  const p = raw as RepoPlan | null;
  return p && typeof p === "object" && p.version === 1 && p.item === REPO_ITEM && typeof p.from === "string" && typeof p.to === "string"
    && typeof p.sourceKey === "string" && typeof p.planKey === "string" ? p : null;
}

const valuesOf = (remotes: readonly RemoteEntry[], remote: string, key: UrlKey): readonly string[] | null => {
  const r = remotes.find((x) => x.name === remote);
  return r ? (key === "url" ? r.urls : r.pushUrls) : null;
};

/** 期望的 remote 全集:在 before 上把 changes 逐个从 a 换成 b */
const swapped = (before: readonly RemoteEntry[], changes: readonly UrlChange[], dir: "forward" | "back"): string =>
  remotesKey(before.map((r) => {
    const swap = (key: UrlKey, vals: readonly string[]) => vals.map((v) => {
      const c = changes.find((x) => x.remote === r.name && x.key === key && v === (dir === "forward" ? x.from : x.to));
      return c ? (dir === "forward" ? c.to : c.from) : v;
    });
    return { name: r.name, urls: swap("url", r.urls), pushUrls: swap("pushurl", r.pushUrls) };
  }));

export interface ApplyInput {
  mode: unknown;
  git: RepoGit;
  records: RecordStore;
  /** observe 出来、人看过的那份计划(原样 JSON) */
  plan: unknown;
}

/** on 才写;源 remote 与计划时不一致、已有未回滚的记录、计划有拒绝项,一律 blocked 且零写入 */
export async function applyRepoMigration(input: ApplyInput): Promise<RepoResult> {
  const mode = repoMode(input.mode);
  if (mode === "off") return result(mode, "off");
  const given = asPlan(input.plan);
  if (mode === "observe") return planRepoMigration({ mode, git: input.git, from: given?.from, to: given?.to });
  if (!given) return result(mode, "blocked", { refusals: ["on 需要 observe 出来的计划(version 1、item rename.repo)"] });
  if (given.refusals?.length) return result(mode, "blocked", { plan: given, refusals: ["计划带拒绝项,不执行", ...given.refusals] });
  const prior = await input.records.load();
  if (prior && prior.status !== "rolled-back") {
    return result(mode, "blocked", { record: prior, refusals: [`已有未回滚的迁移记录(${prior.status}),先回滚或人工核对后再迁`] });
  }
  const before = await input.git.listRemotes();
  const fresh = buildRepoPlan(before, given.from, given.to);
  if (fresh.sourceKey !== given.sourceKey || fresh.planKey !== given.planKey || planKeyOf(given) !== given.planKey) {
    return result(mode, "blocked", { plan: fresh, refusals: ["源 remote 与计划时不一致(或计划被改过):旧计划作废,重新 observe"] });
  }
  if (fresh.refusals.length) return result(mode, "blocked", { plan: fresh, refusals: fresh.refusals });
  if (!fresh.changes.length) return result(mode, "applied", { plan: fresh });
  const record: MigrationRecord = { version: 1, item: REPO_ITEM, planKey: fresh.planKey, from: fresh.from, to: fresh.to, changes: fresh.changes, status: "applying" };
  await input.records.save(record);
  try {
    for (const c of fresh.changes) await input.git.setUrl(c.remote, c.key, c.from, c.to);
  } catch (e) {
    return result(mode, "blocked", { plan: fresh, record, refusals: [`改 origin 中途失败:${(e as Error).message};原值在迁移记录里,可回滚`] });
  }
  const after = await input.git.listRemotes();
  if (remotesKey(after) !== swapped(before, fresh.changes, "forward")) {
    return result(mode, "blocked", { plan: fresh, record, refusals: ["改完核对不一致:remote 不是预期的样子;原值在迁移记录里,可回滚"] });
  }
  const done: MigrationRecord = { ...record, status: "applied" };
  await input.records.save(done);
  return result(mode, "applied", { plan: fresh, record: done });
}

export interface RollbackInput {
  mode: unknown;
  git: RepoGit;
  records: RecordStore;
}

/** 按记录恢复本地 origin 原值;observe 只报告。当前值既不是记录的新值也不是原值 → 拒绝,一处都不写 */
export async function rollbackRepoMigration(input: RollbackInput): Promise<RepoResult> {
  const mode = repoMode(input.mode);
  if (mode === "off") return result(mode, "off");
  const record = await input.records.load();
  if (!record) return result(mode, "blocked", { refusals: ["没有迁移记录:回滚只按记录恢复原值,不推算"] });
  if (record.status === "rolled-back") return result(mode, "rolled-back", { record });
  const before = await input.git.listRemotes();
  const pending: UrlChange[] = [];
  const refusals: string[] = [];
  for (const c of record.changes) {
    const vals = valuesOf(before, c.remote, c.key);
    if (vals?.length === 1 && vals[0] === c.from) continue;
    if (vals?.length === 1 && vals[0] === c.to) pending.push(c);
    else refusals.push(`${c.remote}.${c.key} 现在是 ${JSON.stringify(vals ?? null)},既不是迁移写的新值也不是原值:不覆盖,人工核对`);
  }
  if (refusals.length) return result(mode, "blocked", { record, refusals });
  if (mode === "observe") return result(mode, "observed", { record });
  try {
    for (const c of pending) await input.git.setUrl(c.remote, c.key, c.to, c.from);
  } catch (e) {
    return result(mode, "blocked", { record, refusals: [`恢复中途失败:${(e as Error).message};记录未改,可重跑回滚`] });
  }
  const after = await input.git.listRemotes();
  if (remotesKey(after) !== swapped(before, pending, "back")) {
    return result(mode, "blocked", { record, refusals: ["恢复后核对不一致:remote 不是预期的样子,人工核对"] });
  }
  const done: MigrationRecord = { ...record, status: "rolled-back" };
  await input.records.save(done);
  return result(mode, "rolled-back", { record: done });
}
