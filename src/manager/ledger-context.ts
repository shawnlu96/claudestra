/**
 * `ledger` 各子命令共用的运行上下文：依赖（库、actor、registry、项目表）、项目解析、角色判定、目标解析。
 * 角色矩阵（docs 10-ledger §3「动作 × 角色」）里阶段以外的部分在这里执行；阶段角色与 owner 专属项在 lib（ledger-write.ts）。
 * 依赖全部注入，测试不碰真实 registry / 状态目录（tests/manager-ledger.test.ts）。
 */
import type { Database } from "bun:sqlite";
import type { SnapshotSources } from "../lib/ledger-audit-snapshot.js";
import { roleOf, type LedgerTask, type Role } from "../lib/ledger-stages.js";
import { getItem, getMeta, getTask, LedgerError } from "../lib/ledger-store.js";
import type { FactsDeps } from "../lib/ledger-verify-facts.js";
import type { ProjectDef } from "../lib/projects.js";
import type { WriteCtx } from "../lib/ledger-write.js";
import type { Registry } from "./core.js";
import type { ProposeOpts } from "./team-up.js";
import type { ParsedArgs } from "./ledger-identity.js";

export interface LedgerDeps {
  db: Database;
  /** 已推导好的身份：agent-xxx / master / owner */
  actor: string;
  /** actor 所属项目（registry projectId），给不带 --project 的命令当默认值 */
  actorProject?: string;
  /** projects.json 里的项目 id：台账的 project 必须在里面（读接口按它校验） */
  projectIds: readonly string[];
  loadRegistry(): Promise<Registry>;
  saveRegistry(reg: Registry): Promise<void>;
  now(): number;
  /** dispatch 核对 head 用；不给 = 真跑 git（单测注入） */
  gitHead?(dir: string): string | null;
  /** 班子提案（meta --pms、team-apply）存哪、按钮怎么贴；不给 = 状态目录 + 真贴按钮（单测注入） */
  proposals?: ProposeOpts;
  /** 完成检查单的事实采集（gh / git / 进程）；不给就用真实的（lib/ledger-verify-facts.ts），测试注入假的 */
  factsDeps?(): FactsDeps;
  /** projects.json 的项目清单（verify 按目录判断任务所属项目是否拥有本仓库）；不给按拥有算 */
  projects?(): ProjectDef[];
  /** ledger audit 的取数来源；不给 = 真实的 registry / tmux / 文件（测试注入假的） */
  auditSources?: SnapshotSources;
}

export type Result = Record<string, unknown>;

export class LedgerCli {
  constructor(
    readonly deps: LedgerDeps,
    readonly p: ParsedArgs,
  ) {}

  get db(): Database {
    return this.deps.db;
  }

  /** 事件时间由命令填；--dedup 透传给库做幂等 */
  ctx(): WriteCtx {
    return { actor: this.deps.actor, now: this.deps.now(), ...(this.p.flags.dedup !== undefined ? { dedupKey: this.p.flags.dedup } : {}) };
  }

  /** --project，缺省 actor 所属项目；必须在 projects.json 里 */
  project(): string {
    const id = this.p.flags.project ?? this.deps.actorProject;
    if (!id) throw new LedgerError("invalid", "要带 --project <项目 id>（你不属于任何项目，推不出默认值）");
    if (!this.deps.projectIds.includes(id)) throw new LedgerError("not_found", `projects.json 里没有项目 ${id}`);
    return id;
  }

  task(id: string | undefined): LedgerTask {
    if (!id) throw new LedgerError("invalid", "缺任务 id");
    const t = getTask(this.db, id);
    if (!t) throw new LedgerError("not_found", `没有任务 ${id}`);
    return t;
  }

  role(project: string, task?: Pick<LedgerTask, "agent">): Role | null {
    return roleOf(this.deps.actor, task ?? { agent: null }, getMeta(this.db, project).pms);
  }

  /** PM 名单里的人、master、owner */
  requireManager(project: string, what: string): void {
    const r = this.role(project);
    if (r === null || r === "executor") throw new LedgerError("forbidden", `${what}要项目 ${project} 的 PM / master / owner（你是 ${this.deps.actor}）`);
  }

  /** 真正的 PM：名单里除了班子调度助理以外的人，或 master / owner（调度助理也在 PM 名单里，PM 专属的出口不能交给它） */
  isRealPm(project: string): boolean {
    const r = this.role(project);
    return r === "master" || r === "owner" || (r === "pm" && getMeta(this.db, project).team?.dispatcher !== this.deps.actor);
  }

  requireRealPm(project: string, what: string): void {
    if (!this.isRealPm(project)) throw new LedgerError("forbidden", `${what}只有项目 ${project} 的 PM（调度助理除外）/ master / owner 能做（你是 ${this.deps.actor}）`);
  }

  /** 任务的执行者本人，或 PM / master / owner */
  requireOwnOrManager(task: LedgerTask, what: string): void {
    if (this.role(task.project, task) === null) throw new LedgerError("forbidden", `${what}只能是任务 ${task.id} 的执行者或 PM / master / owner（你是 ${this.deps.actor}）`);
  }

  /** note / decision 的目标：`-` = 项目级；任务 id（项目取任务的）；本项目的事项 id */
  target(raw: string | undefined): { project: string; target: string; task: LedgerTask | null } {
    if (!raw) throw new LedgerError("invalid", "缺目标（任务 id / 事项 id / - 表示项目级）");
    if (raw === "-") return { project: this.project(), target: "", task: null };
    const task = getTask(this.db, raw);
    if (task) return { project: task.project, target: raw, task };
    const project = this.project();
    if (!getItem(this.db, project, raw)) throw new LedgerError("not_found", `项目 ${project} 里没有任务或事项 ${raw}`);
    return { project, target: raw, task: null };
  }

  /** 位置参数 from 起拼成正文（note / decision 的原话） */
  text(from: number): string {
    const t = this.p.pos.slice(from).join(" ").trim();
    if (!t) throw new LedgerError("invalid", "缺正文");
    return t;
  }

  need(flag: string): string {
    const v = this.p.flags[flag];
    if (v === undefined || v === "") throw new LedgerError("invalid", `缺 --${flag}`);
    return v;
  }
}
