/**
 * 项目地图这一批（PDLAYOUT1 起）的对照数据：纯 TS，只用合成的 id 和标题，成员只有「本机」「机器 B」。
 * 主区 16 个（在跑 5、受阻 1、久未动 2、可以开工 3、待验收 3、在等前置 2）：3 串链 + 8 个独立推进；已暂停 2、已收尾 8、dropped 1。
 * 旧组件忽略新字段，所以 origin/main 上同样能渲染，截图能成对。形状说明见规格「对照基准」。
 */
import type { ProductBoard, ProductFeature, ProductFrontierItem, ProductLockEvidence, ProductTaskEvidence } from "../../web/lib/api/product-board-types";

const H = 3600_000, D = 24 * H;
const SPLIT = "feature-split 默认前置";

type Patch = Partial<ProductFeature> & { area?: string | null };
function feature(id: string, title: string, area: string | null, patch: Patch = {}): ProductFeature {
  return { id, title, status: "active", hasDag: true, version: 1, counts: { total: 6, completed: 2, active: 0, blocked: 0 }, eta: null, area, ...patch };
}
const row = (key: string, title: string, stage: string | null, sinceMs: number | null, extra: Partial<ProductFrontierItem> = {}): ProductFrontierItem =>
  ({ key, taskId: stage === null ? null : `t-${key}`, title, stage, round: 1, member: stage === null ? null : "本机", sinceMs, ...extra });

/** now 固定为 2026-10-14 12:00（Asia/Shanghai）时用 Date.UTC(2026, 9, 14, 4) */
export function projectMapBoard(now: number): ProductBoard {
  const ago = (ms: number) => now - ms;
  const run = (patch: Patch): Patch => ({ state: "run", lastActivityAt: ago(H), eta: { at: now + 2 * D, basis: {} }, ...patch });
  const done = (id: string, title: string, area: string, patch: Patch = {}) =>
    feature(id, title, area, { status: "done", state: "done", complete: true, counts: { total: 5, completed: 5, active: 0, blocked: 0 }, eta: null, ...patch });
  const features: ProductFeature[] = [
    // 链 1：共享台账（已收尾）→ 私有云拆分 → 团队项目 →（锁）成员名册；团队项目 →（锁）私有云拆分成环
    feature("f-private", "私有云拆分", "team", run({ counts: { total: 8, completed: 3, active: 2, blocked: 0 }, lastActivityAt: ago(2 * H),
      eta: { at: now + 2 * D, basis: { cpHours: 10 } },
      frontier: [row("pc-3", "拆出配置读取", "build", ago(3 * H)), row("pc-4", "拆出同步通道", "review", ago(5 * H))] })),
    feature("f-team", "团队项目", "team", run({ counts: { total: 12, completed: 4, active: 4, blocked: 0 }, lastActivityAt: ago(H / 2),
      eta: { at: now + 4 * D, basis: { cpHours: 23 } }, frontier: [row("tp-5", "成员同步", "build", ago(2 * H)),
        row("tp-6", "共享项目列表", "build", ago(4 * H), { member: "机器 B" }), row("tp-7", "邀请流程", "fix", ago(6 * H), { round: 2 }),
        row("tp-8", "离开项目", "review", ago(8 * H)), row("tp-9", "权限校验", null, null)] })),
    feature("f-roster", "成员名册", "team", { state: "wait", counts: { total: 4, completed: 0, active: 0, blocked: 0, waiting: 4 }, lastActivityAt: ago(2 * D) }),
    // 链 2：派单恢复（受阻）→ 合并提速
    feature("f-dispatch", "派单恢复", "sched", { state: "blocked", counts: { total: 7, completed: 2, active: 2, blocked: 1 }, lastActivityAt: ago(3 * H),
      eta: { at: now + 3 * D, basis: { cpHours: 6 } }, frontier: [row("dr-2", "恢复队列", "blocked", ago(3 * D)), row("dr-3", "重放日志", "build", ago(H)),
        row("dr-4", "失败重试", "review", ago(2 * H))] }),
    feature("f-merge", "合并提速", "sched", run({ counts: { total: 5, completed: 1, active: 1, blocked: 0 }, lastActivityAt: ago(4 * H),
      eta: { at: now + 5 * D, basis: { cpHours: 4 } }, frontier: [row("mg-2", "合并队列并行", "build", ago(4 * H))] })),
    // 链 3：调度引擎（久未动）→ 借算力协议（可以开工）→ 直连优先（在等前置）；协作底座改版 split 到借算力协议
    feature("f-sched", "调度引擎", "sched", { state: "stale", counts: { total: 6, completed: 3, active: 1, blocked: 0 }, lastActivityAt: ago(4 * D),
      frontier: [row("se-4", "优先级重排", "build", ago(4 * D))] }),
    feature("f-lend", "借算力协议", "lend", { state: "ready", counts: { total: 6, completed: 1, active: 0, blocked: 0, ready: 2 }, lastActivityAt: ago(D),
      eta: { at: now + 6 * D }, frontier: [row("lp-2", "握手格式", "spec", ago(D)), row("lp-3", "额度上报", null, null)] }),
    feature("f-direct", "直连优先", "lend", { state: "wait", counts: { total: 20, completed: 1, active: 0, blocked: 0, waiting: 19 }, lastActivityAt: ago(3 * D) }),
    // 独立推进 8 个
    feature("f-sessions", "会话列表恢复", "agent", run({ counts: { total: 9, completed: 4, active: 3, blocked: 0 }, frontier: [
      row("sl-5", "列表分页", "build", ago(H)), row("sl-6", "滚动位置", "review", ago(2 * H)), row("sl-7", "空态", "build", ago(3 * H))] })),
    feature("f-bgtask", "后台任务状态", "base", { state: "gate", counts: { total: 5, completed: 4, active: 0, blocked: 0 }, lastActivityAt: ago(6 * H),
      frontier: [row("PAGEOK", "看界面", "spec", ago(6 * H))] }),
    feature("f-reliab", "跟进可靠性", "base", { state: "gate", counts: { total: 4, completed: 3, active: 0, blocked: 0 }, lastActivityAt: ago(8 * H),
      frontier: [row("PAGEOK", "看界面", "spec", ago(8 * H))] }),
    feature("f-quota", "额度与执行者", "agent", { state: "gate", counts: { total: 6, completed: 5, active: 0, blocked: 0 }, lastActivityAt: ago(10 * H),
      frontier: [row("PAGEOK", "看界面", "spec", ago(10 * H))] }),
    feature("f-agents", "Agent 管理", "agent", { state: "stale", counts: { total: 7, completed: 2, active: 1, blocked: 0 }, lastActivityAt: ago(5 * D),
      frontier: [row("am-3", "列表冻结项", "build", ago(5 * D), { frozen: true }), row("am-4", "管理页规格", "spec", ago(14 * D))] }),
    feature("f-discord", "Discord 拆出", "ui", { state: "ready", counts: { total: 3, completed: 0, active: 0, blocked: 0, ready: 1 }, lastActivityAt: ago(2 * D),
      eta: { at: now + 7 * D }, frontier: [row("dc-1", "拆出适配层", "spec", ago(2 * D))] }),
    feature("f-rename", "界面改名", "ui", run({ counts: { total: 4, completed: 2, active: 1, blocked: 0 }, lastActivityAt: ago(3 * H),
      frontier: [row("rn-3", "词表替换", "build", ago(3 * H))] })),
    feature("f-runtime", "运行时整理", null, { state: "ready", hasDag: false, version: 0, counts: { total: 2, completed: 0, active: 0 },
      cards: [{ id: "rt-1", title: "清理旧进程表", stage: "spec" }, { id: "rt-2", title: "统一退出码", stage: "spec" }], lastActivityAt: ago(D),
      eta: { at: now + 3 * D }, frontier: [row("rt-1", "清理旧进程表", "spec", ago(D))] }),
    // 已暂停 2 个
    feature("f-codex", "Codex 调用", "agent", { status: "paused", state: "paused", counts: { total: 5, completed: 1, active: 0, blocked: 0 }, lastActivityAt: ago(9 * D) }),
    feature("f-msg", "消息投递", "base", { state: "frozen", counts: { total: 4, completed: 1, active: 0, blocked: 0 }, lastActivityAt: ago(6 * D),
      frontier: [row("mq-2", "投递重试", "build", ago(6 * D), { frozen: true }), row("mq-3", "回执", "spec", ago(6 * D), { frozen: true })] }),
    // 已收尾 8 个（含 1 个全部完成还没关单）+ dropped 1 个
    done("f-ledger", "共享台账", "team"), done("f-base", "协作底座改版", "base"), done("f-dag", "台账与子 DAG", "base"),
    done("f-unclosed", "看板筛选", "ui", { status: "active" }), done("f-relay", "中继握手", "lend"), done("f-tabs", "标签整理", "ui"),
    done("f-runner", "执行器重启", "agent"), done("f-queue", "派单队列", "sched"),
    feature("f-gone", "废弃方案", "ui", { status: "dropped", counts: { total: 0, completed: 0, active: 0, blocked: 0 } }),
  ];
  const taskEv = (n: number): ProductTaskEvidence[] => Array.from({ length: n }, (_, i) =>
    ({ from: `pc-${i + 1}`, to: `tp-${i + 1}`, fromStage: i ? "done" : "build", toStage: "spec", satisfied: i > 0 }));
  const lockEv = (n: number): ProductLockEvidence[] => Array.from({ length: n }, (_, i) =>
    ({ node: `pc-${i + 3}`, wanted: `src/x/part-${i}.ts`, held: "src/x/**", holder: `tp-${5 + (i % 3)}`, since: ago((i + 1) * H) }));
  return {
    features,
    deps: [
      { from: "f-ledger", to: "f-private", note: "等共享台账的卡合完", kind: "declared", satisfied: true, count: 1, evidence: [] },
      { from: "f-dispatch", to: "f-merge", note: "等派单恢复合完", kind: "declared", satisfied: false, count: 1, evidence: [] },
      { from: "f-lend", to: "f-direct", note: "等借算力协议定稿", kind: "declared", satisfied: false, count: 1, evidence: [] },
      { from: "f-base", to: "f-lend", note: SPLIT, kind: "split", satisfied: true, count: 1, evidence: [] },
      { from: "f-dag", to: "f-quota", note: SPLIT, kind: "split", satisfied: true, count: 1, evidence: [] },
    ],
    links: [
      { from: "f-private", to: "f-team", note: "", kind: "task", satisfied: false, count: 3, evidence: taskEv(3) },
      { from: "f-sched", to: "f-lend", note: "", kind: "task", satisfied: true, count: 1,
        evidence: [{ from: "se-3", to: "lp-1", fromStage: "done", toStage: "spec", satisfied: true }] },
      { from: "f-team", to: "f-private", note: "", kind: "lock", satisfied: false, count: 6, evidence: lockEv(6) },
      { from: "f-team", to: "f-roster", note: "", kind: "lock", satisfied: false, count: 1,
        evidence: [{ node: "rs-1", wanted: "web/roster/list.tsx", held: "web/roster/**", holder: "tp-6", since: ago(2 * H) }] },
    ],
    areas: [{ id: "sched", name: "调度、合并与工程" }, { id: "base", name: "台账与协作底座" }, { id: "lend", name: "跨机借算力与中继" },
      { id: "team", name: "团队与共享台账" }, { id: "agent", name: "Agent 与运行时" }, { id: "ui", name: "界面与产品" }],
  };
}

/** 截图与 DOM 测试用的固定时刻：2026-10-14 12:00 Asia/Shanghai */
export const PROJECT_MAP_NOW = Date.UTC(2026, 9, 14, 4);
