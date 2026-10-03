/**
 * `ledger` 各子命令共用的运行上下文：依赖（库、actor、registry、项目表）、项目解析、角色判定、目标解析。
 * 角色矩阵（docs 10-ledger §3「动作 × 角色」）里阶段以外的部分在这里执行；阶段角色与 owner 专属项在 lib（ledger-write.ts）。
 * 依赖全部注入，测试不碰真实 registry / 状态目录（tests/manager-ledger.test.ts）。
 */
import type { CallerWitness } from "../lib/caller-witness.js";
import type { Database } from "bun:sqlite";
import type { SnapshotSources } from "../lib/ledger-audit-snapshot.js";
import { isManagerRole, roleOf, type LedgerTask, type Role } from "../lib/ledger-stages.js";
import { getItem, getMeta, getTask, LedgerError } from "../lib/ledger-store.js";
import { isRealPmRole } from "../lib/ledger-team-config.js";
import type { FactsDeps } from "../lib/ledger-verify-facts.js";
import type { ProjectDef } from "../lib/projects.js";
import type { WriteCtx } from "../lib/ledger-write.js";
import type { Registry } from "./core.js";
import type { ProposeOpts } from "./team-up.js";
import type { ParsedArgs } from "./ledger-identity.js";
import type { LendCliDeps } from "./ledger-lend-cmds.js";
import type { Gh } from "../lib/lend-fix-reassign-pr.js";

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
  /** 调度服务子进程：同步核父进程租约，失租抛 SchedulerLeaseLost；紧挨写入调，中间不隔 await（lib/scheduler-lease-env.ts） */
  assertLease?(): void;
  /** Scheduler bind reads this registry snapshot path inside its ledger transaction; tests inject an isolated file. */
  registryPath?: string;
  now(): number;
  /** dispatch 核对 head 用；不给 = 真跑 git（单测注入） */
  gitHead?(dir: string): string | null;
  /** 自动卡回写时核审查目录有没有未提交改动；不给 = 真跑 git（单测注入） */
  gitDirty?(dir: string): string | null;
  /** 自动卡结论的旁证（tmux 窗口 / 父进程链 / cwd），只记录比对不拦；不给 = 不记 */
  callerWitness?(): Promise<CallerWitness>;
  /** 班子提案（meta --pms、team-apply）存哪、按钮怎么贴；不给 = 状态目录 + 真贴按钮（单测注入） */
  proposals?: ProposeOpts;
  /** 完成检查单的事实采集（gh / git / 进程）；不给就用真实的（lib/ledger-verify-facts.ts），测试注入假的 */
  factsDeps?(): FactsDeps;
  /** projects.json 的项目清单（verify 按目录判断任务所属项目是否拥有本仓库）；不给按拥有算 */
  projects?(): ProjectDef[];
  /** ledger audit 的取数来源；不给 = 真实的 registry / tmux / 文件（测试注入假的） */
  auditSources?: SnapshotSources;
  /** 调用方运行时给的会话 id（CLAUDESTRA_SESSION_ID / CLAUDE_CODE_SESSION_ID）：自动卡的审查结论要它等于台账绑定的 session */
  callerSession?: string;
  /** 调度服务在跑自动 tick 的项目（scheduler.json enabled 时的 projects）；不在里面的卡开 auto 没人推，workflow-set 拒绝 */
  autoProjects?(): string[];
  /** scheduler.json autoDispatch；不为 true 时 workflow-set 拒绝开 auto（T68h 修好子进程重核前默认关） */
  autoDispatch?(): boolean;
  /** 系统通知送到 owner（借算力开跑 / 交付 / 停止通知用；dag-rewrite 直接生效不通知 owner）：true = bridge 收下了；不给 = 这个进程没有通道，结果里写「未通知」 */
  notifyOwner?(text: string): Promise<boolean>;
  /** 出借（T93）的 borrow 名单、通知 PM、结论落盘与回执签名；不给 = 读真实的 lend.json / 实例钥匙（单测注入） */
  lend?: LendCliDeps;
  /** 自动改派交付后关旧 PR 用的 gh（i28-RA1）；不给 = 真跑 gh（单测注入） */
  relayGh?: Gh;
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
    if (!isManagerRole(r)) throw new LedgerError("forbidden", `${what}要项目 ${project} 的 PM / master / owner（你是 ${this.deps.actor}）`);
  }

  /** 真正的 PM：名单里除了班子调度助理以外的人，或 master / owner（调度助理也在 PM 名单里，PM 专属的出口不能交给它） */
  isRealPm(project: string): boolean {
    return isRealPmRole(this.role(project), this.deps.actor, getMeta(this.db, project).team);
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
