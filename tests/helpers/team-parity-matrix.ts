/**
 * 团队视图 ↔ 本机协作视图覆盖矩阵（team-parity-C）。期望值照 docs/team/team-collab-parity-plan.md §3 的 A–F 分类写死：
 * A 两边 present；B 读口已给 → 团队应 present；C/D 没读口 / 契约没有 → 团队诚实地 absent 或「暂无」(unknown)；
 * E 权限不同 → home_only；F 假数据 / 误调 → 团队应 unknown / absent。本机夹具是全量的，本机一律按 present / absent 写死。
 * gap = 现在 main 上已知的偏差（团队实测值 + 负责修它的节点）：照实输出为 known_gap，不把期望改成现状。
 * team-parity-Cf1：P1-A 合并后真实 Chromium 1200/390 × 浅/深四场景实测这 9 行都已命中期望（指标「暂无」、谁在干活「执行操作仍在主场」、
 * 本机接口 0 次请求），删掉 P1-A 的 gap；期望值和本机真值一个没动，其余节点的 gap 照旧。
 * 规则：后续节点合并后只能删掉对应 gap、或把 team 期望往 present 方向改（absent/unknown/home_only → present），不准删行、不准放宽本机期望。
 * §3 每一行都在表里：没有检测入口的写 limit（原因照实，结果是 not_run），其余每行至少一个场景真测到；实测里出现表外区块判 unlisted。
 */
type LocalState = "present" | "absent";
export type TeamState = LocalState | "home_only" | "unknown";
type View = "home" | "task" | "versions" | "diff" | "work" | "team";

export interface MatrixRow {
  section: string;
  /** §3 的行号 */
  ref: string;
  view: View;
  cls: "A" | "B" | "C" | "D" | "E" | "F";
  local: LocalState;
  team: TeamState;
  gap?: { team: TeamState; node: string };
  /** 本夹具测不到的原因（无入口 / 夹具里没有这类数据）；有它的行允许 not_run，没有它的行桌面上必须测到 */
  limit?: string;
}

/** 「…误调」行的 present = 发出了那条本机请求（看请求记录，不看界面） */
export const MATRIX: readonly MatrixRow[] = [
  { section: "在场 agent", ref: "M1", view: "home", cls: "F", local: "present", team: "unknown" },
  { section: "进行中", ref: "M2", view: "home", cls: "A", local: "present", team: "present" },
  { section: "今日完成", ref: "M3", view: "home", cls: "F", local: "present", team: "unknown" },
  { section: "审查轮次", ref: "M4", view: "home", cls: "D", local: "present", team: "unknown" },
  { section: "P0/P1 修掉", ref: "M4", view: "home", cls: "D", local: "present", team: "unknown" },
  { section: "平均等复核", ref: "M5", view: "home", cls: "D", local: "present", team: "unknown" },
  { section: "待你处理", ref: "W1", view: "home", cls: "F", local: "present", team: "unknown" },
  { section: "上次以来", ref: "W2", view: "home", cls: "C", local: "present", team: "absent" },
  { section: "上次以来·本机接口误调", ref: "W2", view: "home", cls: "F", local: "present", team: "absent" },
  { section: "产品 DAG 卡片", ref: "G1", view: "home", cls: "A", local: "present", team: "present" },
  { section: "标题", ref: "T1", view: "task", cls: "A", local: "present", team: "present" },
  { section: "现在·停留时长", ref: "T2", view: "task", cls: "D", local: "present", team: "absent" },
  { section: "阶段用时", ref: "T3", view: "task", cls: "D", local: "present", team: "absent" },
  { section: "因果线", ref: "T4", view: "task", cls: "A", local: "present", team: "present" },
  { section: "最近 3 件事", ref: "T5", view: "task", cls: "C", local: "present", team: "home_only", gap: { team: "absent", node: "P1-I" } },
  { section: "回放", ref: "T6", view: "task", cls: "E", local: "present", team: "home_only", gap: { team: "absent", node: "P1-I" } },
  { section: "审查", ref: "T7", view: "task", cls: "D", local: "present", team: "home_only", gap: { team: "absent", node: "P1-I" } },
  { section: "参与者", ref: "T8", view: "task", cls: "B", local: "present", team: "present", gap: { team: "absent", node: "P1-B" } },
  { section: "打开会话 / 对它说", ref: "T9", view: "task", cls: "E", local: "present", team: "home_only", gap: { team: "absent", node: "P1-I" } },
  { section: "步骤线", ref: "T10", view: "task", cls: "B", local: "present", team: "present", gap: { team: "absent", node: "P1-B" } },
  { section: "团队操作", ref: "T13", view: "task", cls: "E", local: "absent", team: "present" },
  { section: "子 DAG 节点", ref: "G2", view: "versions", cls: "A", local: "present", team: "present" },
  { section: "版本历史", ref: "G5", view: "versions", cls: "C", local: "present", team: "unknown", gap: { team: "absent", node: "P1-F" } },
  { section: "两版对比", ref: "G8", view: "diff", cls: "C", local: "present", team: "unknown", gap: { team: "absent", node: "P1-F" } },
  { section: "谁在干活", ref: "W3", view: "work", cls: "F", local: "present", team: "home_only" },
  { section: "谁在干活·本机接口误调", ref: "W3", view: "work", cls: "F", local: "present", team: "absent" },
  { section: "团队成员卡（本机 peers）", ref: "W4", view: "team", cls: "F", local: "present", team: "absent" },
  { section: "团队标签·本机接口误调", ref: "W4", view: "team", cls: "F", local: "present", team: "absent" },
  { section: "团队规划", ref: "T13", view: "team", cls: "E", local: "absent", team: "present" },
  // ---- §3 其余各行（r1 补齐）：present 的口径见 tests/web-team-parity-browser.test.ts 对应检测器，值要和本机真值对上才算 present ----
  { section: "节点阶段（大纲行）", ref: "G3", view: "versions", cls: "A", local: "present", team: "present" },
  // F：契约没有边元数据，团队显示出任何建立者 / 时间都是 feature 级冒充（present = 显示了），修好应是「未记录」
  { section: "依赖边·建立者/时间", ref: "G4", view: "task", cls: "F", local: "present", team: "unknown", gap: { team: "present", node: "P1-B" } },
  { section: "版本元数据（提出人/时间）", ref: "G6", view: "versions", cls: "C", local: "present", team: "unknown", gap: { team: "absent", node: "P1-F" } },
  { section: "历史版本快照", ref: "G7", view: "versions", cls: "C", local: "present", team: "unknown",
    limit: "版本页要逐行点开快照；团队没有版本行（G5 已记缺口），本夹具只测 G5 / G8" },
  { section: "等批的重写", ref: "G9", view: "versions", cls: "E", local: "present", team: "absent", limit: "夹具里没有待批提案；V1 不接受提案（按设计不做）" },
  { section: "节点处理人/步骤", ref: "G10", view: "versions", cls: "B", local: "present", team: "present", gap: { team: "absent", node: "P1-B" } },
  // present = 显示的轮次等于本机真值（i28-B2 第 2 轮）；团队现在显示第 1 轮，按 absent（错值不算有）
  { section: "轮次（大纲行）", ref: "G10", view: "versions", cls: "B", local: "present", team: "present", gap: { team: "absent", node: "P1-B" } },
  { section: "head", ref: "G11", view: "task", cls: "B", local: "present", team: "present", gap: { team: "absent", node: "P1-B" } },
  { section: "进度条 counts", ref: "G12", view: "home", cls: "A", local: "present", team: "present" },
  // 只看焦点卡的要你定的（i28-A7 阻塞提问）：投影 asks{blocking} 已给，团队现在显示「没有」
  { section: "阻塞提问", ref: "T11", view: "home", cls: "B", local: "present", team: "present", gap: { team: "absent", node: "P1-B" } },
  // §3 记为 A；实测生产交付只存完整 PR 链接（deliverPrPatch），投影只收纯数字 → null，团队详情没有 PR。照实登记，不改期望
  { section: "PR", ref: "T12", view: "task", cls: "A", local: "present", team: "present", gap: { team: "absent", node: "未分配（§3 记 A，实测投影丢 URL 形式 PR）" } },
  // 本机 CollabView 详情本来就不展示规格全文（在规格文件里）；团队显示「全文仅在主场」
  { section: "规格全文", ref: "T14", view: "task", cls: "E", local: "absent", team: "home_only" },
  { section: "台账变更触发重拉", ref: "E1", view: "home", cls: "A", local: "present", team: "present", limit: "夹具服务器不推实时事件，团队 5s 轮询没有在测试里计时" },
  { section: "此刻动作", ref: "E2", view: "home", cls: "E", local: "present", team: "absent", limit: "夹具里没有 tool_* / agent_status 事件流" },
  { section: "刚推进高亮", ref: "E3", view: "home", cls: "A", local: "present", team: "present", limit: "要两次快照之间推进阶段，夹具是静态的" },
  { section: "周额度 / 协作消息", ref: "M6", view: "home", cls: "A", local: "present", team: "present", limit: "两边都是「暂无数据来源」占位，不是数据项" },
  // present = 产品卡「N 进行中」等于本机真值；团队现在是假 0
  { section: "产品卡·进行中计数", ref: "M7", view: "home", cls: "B", local: "present", team: "present", gap: { team: "absent", node: "P1-B" } },
  { section: "产品卡·预计完成", ref: "M7", view: "home", cls: "D", local: "present", team: "absent" },
  { section: "已完成分页", ref: "M8", view: "home", cls: "A", local: "present", team: "present", limit: "夹具总览没有 doneCursor" },
  { section: "镜像新鲜度", ref: "M9", view: "home", cls: "B", local: "absent", team: "present", gap: { team: "absent", node: "P1-B" } },
  { section: "入口", ref: "N1", view: "home", cls: "A", local: "present", team: "present", limit: "截图入口直接挂 CollabView，不经过侧栏入口" },
  { section: "桌面中区标签", ref: "N2", view: "home", cls: "A", local: "present", team: "present" },
  { section: "手机顶栏按钮", ref: "N3", view: "home", cls: "A", local: "present", team: "present" },
  { section: "返回 / 切机器", ref: "N4", view: "home", cls: "A", local: "present", team: "present", limit: "截图入口没有会话外壳" },
  { section: "缓存隔离", ref: "N5", view: "home", cls: "A", local: "present", team: "present", limit: "缓存键是纯函数（collab-cache.ts keyOf），不在浏览器里测" },
];

export type Observed = Record<string, TeamState | "not_run">;
type Verdict = "pass" | "known_gap" | "stale_gap" | "fail" | "not_run" | "unlisted";
export interface MatrixResult {
  section: string; ref: string; side: "local" | "team"; expected: TeamState | null; observed: TeamState | "not_run"; verdict: Verdict; node?: string; limit?: string;
}

/**
 * 一边的实测矩阵对期望：期望命中 = pass；命中登记过的现状 = known_gap；登记的缺口其实已经修好 = stale_gap（要删 gap）；其余 fail。
 * 实测里有、表里没有的区块 = unlisted（检测器和基准对不上，不许静默忽略）。
 */
export function compareMatrix(side: "local" | "team", observed: Observed, rows: readonly MatrixRow[] = MATRIX): MatrixResult[] {
  const listed = new Set(rows.map((r) => r.section));
  const extra = Object.keys(observed).filter((k) => !listed.has(k))
    .map((k): MatrixResult => ({ section: k, ref: "?", side, expected: null, observed: observed[k]!, verdict: "unlisted" }));
  return [...rows.map((r) => {
    const expected = side === "local" ? r.local : r.team, got = observed[r.section] ?? "not_run";
    const base = { section: r.section, ref: r.ref, side, expected, observed: got, ...(r.limit ? { limit: r.limit } : {}) };
    if (got === "not_run") return { ...base, verdict: "not_run" as const };
    if (side === "team" && r.gap) {
      if (got === r.gap.team) return { ...base, verdict: "known_gap" as const, node: r.gap.node };
      if (got === expected) return { ...base, verdict: "stale_gap" as const, node: r.gap.node };
      return { ...base, verdict: "fail" as const, node: r.gap.node };
    }
    return { ...base, verdict: got === expected ? "pass" as const : "fail" as const };
  }), ...extra];
}

/** 没写 limit 的行，至少要在一个场景里真测到（检测器漏掉一行 = 基准悄悄缩水）；传入一边的全部场景 */
export const unprobed = (scenarios: readonly Observed[], rows: readonly MatrixRow[] = MATRIX) =>
  rows.filter((r) => !r.limit && scenarios.every((o) => (o[r.section] ?? "not_run") === "not_run")).map((r) => r.section);

/** 两边实测不一样的区块（差异检出）；没跑的不算 */
export function differing(local: Observed, team: Observed): string[] {
  return MATRIX.filter((r) => local[r.section] && team[r.section] && local[r.section] !== "not_run" && team[r.section] !== "not_run"
    && local[r.section] !== team[r.section]).map((r) => r.section);
}

/** 只许往 present 走的检查：新矩阵相对基准不许删行、不许改本机期望、团队期望只能变成 present */
export function ratchetViolations(base: readonly MatrixRow[], next: readonly MatrixRow[]): string[] {
  const out: string[] = [];
  for (const b of base) {
    const n = next.find((x) => x.section === b.section);
    if (!n) out.push(`${b.section}: removed`);
    else if (n.local !== b.local) out.push(`${b.section}: local ${b.local}→${n.local}`);
    else if (n.team !== b.team && n.team !== "present") out.push(`${b.section}: team ${b.team}→${n.team}`);
  }
  return out;
}
