import { pickRepo } from "./shared-ledger-gate-repo.js";
import { requireSharedLedgerStart } from "./shared-ledger-gate.js";
/**
 * start_node 的预检：动手前把能查的全查了（节点、依赖、文件范围、卡号 / agent 名 / 分支 / worktree 空闲、规格卡、调度服务开没开 auto），
 * 算出一份开工计划（StartPlan）交给 dag-tools-steps.ts 逐步执行。预检不写任何东西——失败在这里的，台账、git、registry 都没动过。
 * 已经绑了卡的节点当成「开工过了」原样回（工具超时后重试不会再建第二张卡）。IO 全部注入，tests/dag-tools-start.test.ts。
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { computeLanes, laneNodes } from "./dag-tools-lanes.js";
import { renderExecPrompt } from "./dag-tools-prompt.js";
import { effectiveNodes, getDagVersion, projectNodes, resolveFeature, type Feature } from "./ledger-feature.js";
import { cardNames } from "./ledger-card-names.js";
import { storedOrigin } from "./ledger-origin.js";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "./ledger-scheduler.js";
import { getItem, getTask } from "./ledger-store.js";
import { canonicalTwinError } from "./registry.js";
import { parseStartPlacement, type StartPlacement } from "./scheduler-placement-start.js";
import { LATEST_TEMPLATE_VERSION } from "./scheduler-template.js";
import { uiSpecGate } from "./spec-lint.js";
import { gitOriginRepo, noCloneReason, privatePoolMode, privateStart, type PrivatePoolMode } from "./card-repo.js";

export interface StartArgs {
  featureId: string;
  key: string;
  base?: string;
  branch?: string;
  taskId?: string;
  title?: string;
  item?: string;
  /** 规格卡正文：ledger/docs/tasks/<卡号>.md 还没有时写进去；已有则拒（不覆盖 PM 写好的） */
  spec?: string;
  /** 项目目录之一；缺省取项目第一个是 git 仓库的目录 */
  repo?: string;
  /** 放哪（i28-W5）：auto（缺省，按槽池规则）| local | peer:<名>（固定给这个 peer，不满足硬约束就拒） */
  placement?: string;
  /** 流程模板（i28-N4）：code（缺省）| ui | security，总是该模板的最高版；开卡那一步就写对，不留 code 窗口 */
  template?: string;
}

/** 预检要读的环境（bridge 注入真实的，测试注入假的） */
export interface StartEnv {
  db: Database;
  caller: string;
  /** 台账目录（statePath("ledger")）：规格卡在 docs/tasks/，说明写进 reviews/ */
  ledgerDir: string;
  /** worktree 放哪（缺省 statePath("worktrees")） */
  worktreeRoot: string;
  projectDirs(project: string): Promise<string[]>;
  agentNames(): string[];
  exists(path: string): boolean;
  branchExists(repo: string, branch: string): Promise<boolean>;
  /** 调度服务会不会推这个项目的 auto 卡（scheduler.json enabled + autoDispatch + 列出项目）；不会就别开 auto，开了没人推 */
  autoReady(project: string): string | null;
  /** ledger/prompts/exec-template.md 的内容；没有为 null */
  template(): string | null;
  /** 槽池放置（lib/scheduler-placement-start.ts）；不注入 = 只能放本机，auto 即 local，peer:<名> 一律拒 */
  placement?(db: Database, q: { project: string; repoDir: string; fileGlobs: readonly string[]; want: "auto" | `peer:${string}` }): Promise<StartPlacement>;
  /** 私仓进池开关（card-repo.ts）；不注入 = 读 statePath("private-pool.json") */
  privatePool?(project: string): PrivatePoolMode;
  /** 目录 origin 的 GitHub owner/name（私仓找 clone 用）；不注入 = 本地 `git remote get-url origin` */
  repoOrigin?(dir: string): string | null;
}

export interface StartPlan {
  /** Explicit local survives recovery before a scheduler session has been bound. */
  localOnly?: boolean;
  feature: Feature;
  key: string;
  taskId: string;
  title: string;
  project: string;
  item: string | null;
  pm: string;
  base: string;
  branch: string;
  repo: string;
  worktree: string;
  /** 不带 agent- 前缀的短名与 registry 规范全名；manager create 收全名（dag-tools-steps.ts agentSteps） */
  agentName: string;
  agent: string;
  fileGlobs: string[];
  specRel: string;
  /** 卡上 task.spec 记这个绝对路径：多数项目没设 docsDir，相对路径 specPathFor 解析不到，派审 / 挂 peer 会找不到规格卡 */
  specPath: string;
  specText: string | null;
  promptPath: string;
  promptText: string;
  purpose: string;
  /** 放到 peer（i28-W5）：不建 worktree、不起本机 agent；null = 本机，步骤与 W5 之前逐字一样 */
  peer?: { name: string; repo: string; reason: string; reservation?: Extract<StartPlacement, { where: "peer" }>["reservation"] } | null;
  /** workflow-set 写的模板与版本，本机卡、peer 卡同一步。preflightStart 总是填；只有手拼的计划（测试）不带，按 code 最高版 */
  workflow?: { template: WorkflowTemplate; version: number };
  /** 私仓卡（开关 on、fileGlobs 带 repo:）的 owner/name：不管放本机还是 peer 都写进 extra.repo（i28-SECPOOL2） */
  privateRepo?: string;
}

export type Preflight = { ok: true; plan: StartPlan } | { ok: true; already: { taskId: string; key: string } } | { ok: false; code: string; error: string };

const REF = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const no = (code: string, error: string): Preflight => ({ ok: false, code, error });

/** feature id 去掉本机前缀后的短名（i28）：卡号 = 短名-节点 key */
function featureSlug(f: Feature, origin: string | null): string {
  return origin && f.id.startsWith(`${origin}-`) ? f.id.slice(origin.length + 1) : f.id;
}

/** 卡号 → agent 名：小写，点号等换成 -（agent 名不许有点号），≤ 48 */
const agentNameFor = (taskId: string): string => `task-${taskId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 48);

function nodeReady(env: StartEnv, f: Feature, key: string) {
  const v = getDagVersion(env.db, f.id, f.currentVersion);
  if (!v) return { error: `feature ${f.id} 还没建 DAG（先 plan_feature）` } as const;
  const views = projectNodes(env.db, effectiveNodes(env.db, v));
  const node = views.find((n) => n.key === key);
  if (!node) return { error: `v${v.version} 里没有节点 ${key}` } as const;
  const lanes = computeLanes(laneNodes(views));
  return { node, wait: lanes.waiting.find((w) => w.key === key && w.why === "deps") ?? null } as const;
}

/** auto 算出本机（或没注入放置）= 本机；peer:<名> 没注入放置 = 拒（不能核对硬约束就不放出去） */
async function placeStart(env: StartEnv, want: "auto" | `peer:${string}`, project: string, repoDir: string, fileGlobs: readonly string[]): Promise<StartPlacement> {
  if (!env.placement) return want === "auto" ? { where: "local", reason: "没有放置信息，放本机" } : { where: "refused", reason: "这台 bridge 没接槽池放置" };
  try {
    return await env.placement(env.db, { project, repoDir, fileGlobs, want });
  } catch (e) {
    const why = `算放置出错：${(e as Error).message}`;
    return want === "auto" ? { where: "local", reason: `${why}，放本机` } : { where: "refused", reason: why };
  }
}

/**
 * 私仓节点（开关 on）开卡用哪个目录：按 fileGlobs 的 repo: 前缀在项目 dirs 里按 origin 找 clone，交给 pickRepo（args.repo 给了以它为准）。
 * null = 公共仓节点或开关不是 on，和改动前一样取项目第一个 git 目录；error = 混了仓库 / 项目 dirs 里没有它的 clone，不落到公共仓。
 */
async function privateRepoDir(env: StartEnv, project: string, globs: readonly string[], want: string | undefined):
  Promise<{ repo: string; dir: string | undefined } | { error: string } | null> {
  const mode = globs.some((g) => g.startsWith("repo:")) ? (env.privatePool ?? privatePoolMode)(project) : "off";
  if (mode !== "on") return null;
  const dirs = want ? [] : await env.projectDirs(project);
  const r = privateStart(project, globs, mode, { dirs: () => dirs, origin: env.repoOrigin ?? gitOriginRepo, exists: (p) => env.exists(p) });
  if (!r || "error" in r) return r;
  if (want) return { repo: r.repo, dir: want };
  return r.dir ? { repo: r.repo, dir: r.dir } : { error: noCloneReason(r.repo) };
}

export async function preflightStart(env: StartEnv, args: StartArgs): Promise<Preflight> {
  let f: Feature;
  try {
    f = resolveFeature(env.db, args.featureId, storedOrigin(env.db));
  } catch (e) {
    return no("not_found", (e as Error).message);
  }
  try { requireSharedLedgerStart(f.id, args.key, () => args.taskId ?? cardNames(env.db, f, args.key).taskId); } catch (e) { return no("forbidden", (e as Error).message); }
  const want = parseStartPlacement(args.placement);
  if (!want) return no("invalid", `placement 只能是 auto / local / peer:<名>（收到 ${String(args.placement).slice(0, 80)}）`);
  const template = args.template ?? "code";
  if (!(WORKFLOW_TEMPLATES as readonly string[]).includes(template)) return no("invalid", `template 只能是 code / ui / security（收到 ${template.slice(0, 80)}）`);
  const r = nodeReady(env, f, args.key);
  if ("error" in r) return no("not_found", r.error as string);
  const { node, wait } = r;
  if (node.taskId) return { ok: true, already: { taskId: node.taskId, key: node.key } };
  if (wait) return no("deps_unmet", `节点 ${node.key} 的依赖还没满足：${wait.on.join(", ")}`);
  if (!node.fileGlobs?.length) return no("no_globs", `节点 ${node.key} 没有 fileGlobs：先用 rewrite_dag 的 update 补上文件范围`);
  const taskId = args.taskId ?? cardNames(env.db, f, node.key).taskId;
  if (!TASK_ID.test(taskId)) return no("invalid", `卡号 ${taskId} 不合法（字母数字开头，≤ 60 位，只含字母数字 _ . -）`);
  const lint = uiSpecGate(env.db, env.ledgerDir, taskId, args.spec, f.project); if (lint) return no("spec_lint", lint);
  // 大小写不同的卡号也算占用：worktree / agent / 分支由小写卡号派生，Case-A 与 case-a 会落到同一个目录
  const taken = getTask(env.db, taskId) ?? (env.db.query("SELECT id FROM tasks WHERE id = ? COLLATE NOCASE").get(taskId) as { id: string } | null);
  if (taken) return no("conflict", `卡号 ${taken.id} 已被占用：换一个 taskId`);
  const low = taskId.toLowerCase();
  const agentName = agentNameFor(taskId);
  const pinned = want.startsWith("peer:");
  // 同名或只差大小写 / 全角的已有会话都算撞（registry 的 canonicalTwinError）：在任何 create / worktree 之前拒，不碰历史会话
  const names = pinned ? [] : env.agentNames();
  if (names.includes(`agent-${agentName}`)) return no("conflict", `agent agent-${agentName} 已存在`);
  const twin = canonicalTwinError(`agent-${agentName}`, names);
  if (twin) return no("conflict", twin);
  const base = args.base ?? "origin/main";
  const branch = args.branch ?? `feat/${low}`;
  if (!REF.test(base) || !REF.test(branch)) return no("invalid", "base / branch 只能是普通分支名（字母数字 . _ / -，不含 .. 与 //）");
  const priv = await privateRepoDir(env, f.project, node.fileGlobs, args.repo);
  if (priv && "error" in priv) return no("private", priv.error);
  const repo = await pickRepo(env, f.project, args.repo ?? priv?.dir);
  if (!repo) return no("invalid", args.repo ? `${args.repo} 不是项目 ${f.project} 的 git 目录` : `项目 ${f.project} 没有 git 仓库目录`);
  if (await env.branchExists(repo, branch)) return no("conflict", `分支 ${branch} 已存在：换一个 branch`);
  const worktree = join(env.worktreeRoot, low);
  if (!pinned && env.exists(worktree)) return no("conflict", `worktree 目录 ${worktree} 已存在`);
  const specRel = `docs/tasks/${taskId}.md`;
  const specPath = join(env.ledgerDir, specRel);
  const hasSpec = env.exists(specPath);
  if (!hasSpec && !args.spec?.trim()) return no("no_spec", `规格卡 ${specPath} 还没有：先写好，或在 spec 参数里给正文`);
  if (hasSpec && args.spec !== undefined) return no("conflict", `规格卡 ${specPath} 已存在：不覆盖，去掉 spec 参数`);
  const auto = env.autoReady(f.project);
  if (auto) return no("auto_off", auto);
  const placed = want === "local" ? null : await placeStart(env, want, f.project, repo, node.fileGlobs);
  if (placed?.where === "refused") return no("placement", `不能放到 ${want}：${placed.reason}`);
  const title = args.title ?? node.oneLine;
  const item = args.item ?? (getItem(env.db, f.project, featureSlug(f, storedOrigin(env.db))) ? featureSlug(f, storedOrigin(env.db)) : null);
  const promptPath = join(env.ledgerDir, "reviews", `${taskId}-exec-prompt.md`);
  const vars = { task: taskId, title, pm: env.caller, branch, base, worktree, spec: specPath, ledgerDir: env.ledgerDir, template: template as WorkflowTemplate };
  const promptText = renderExecPrompt(vars, env.template() ?? undefined);
  return {
    ok: true,
    plan: {
      feature: f, key: node.key, taskId, title, project: f.project, item, pm: env.caller, base, branch, repo, worktree, agentName, agent: `agent-${agentName}`,
      fileGlobs: node.fileGlobs, specRel, specPath, specText: hasSpec ? null : (args.spec as string), promptPath, promptText,
      purpose: `${taskId} 执行者（自动卡）：${title}。先读 ${promptPath}`,
      ...(want === "local" ? { localOnly: true } : {}),
      peer: placed?.where === "peer" ? { name: placed.peer, repo: placed.repo, reason: placed.reason, reservation: placed.reservation } : null,
      workflow: { template: template as WorkflowTemplate, version: LATEST_TEMPLATE_VERSION[template as WorkflowTemplate] },
      ...(priv ? { privateRepo: priv.repo } : {}),
    },
  };
}

/**
 * 本次开工要独占的资源，规范成小写（macOS 文件系统与 git 引用不分大小写）。bridge 在预检之后、动手之前一次占齐：
 * 两次并发都过了预检，只有先占到的那次动手，后者直接拒——不然后者失败回滚时会删掉前者刚建的 worktree / agent。
 */
export function startClaims(p: StartPlan): string[] {
  return [`task:${p.taskId}`, `agent:${p.agent}`, `branch:${p.repo}:${p.branch}`, `path:${p.worktree}`, `path:${p.specPath}`, `path:${p.promptPath}`].map((k) => k.toLowerCase());
}
