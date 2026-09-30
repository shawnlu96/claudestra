/**
 * plan_feature / rewrite_dag 的参数校验与「下一版节点」拼装（纯函数，bridge/dag-tools.ts 调用后交给 `ledger dag-init / dag-rewrite`）。
 * 工具层比 CLI 多一道：每个新写的节点必须带非空 fileGlobs（CLI 为兼容旧写法可以不带）；删进行中的节点必须走 cancel 带原因。
 * 其余规矩（key 格式、依赖成环、已完成节点原样带入……）仍由 CLI 那一层（lib/ledger-feature-write.ts、ledger-dag-rules.ts）判，这里不重写一份。
 */
import type { NodePhase } from "./ledger-dag-rules.js";
import type { DagNode } from "./ledger-feature.js";

/** 交给 CLI --nodes 的一项 */
export interface NodeInput {
  key: string;
  taskId?: string | null;
  oneLine: string;
  deps: string[];
  estimate?: string;
  fileGlobs?: string[];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const strArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

/** 工具收的节点：key / oneLine 必填，fileGlobs 必须是非空字符串数组（缺、空、非字符串一律拒） */
export function parseToolNodes(raw: unknown, what = "nodes"): Parsed<NodeInput[]> {
  if (!Array.isArray(raw)) return { ok: false, error: `${what} 要是数组` };
  const out: NodeInput[] = [];
  for (const [i, x] of raw.entries()) {
    if (!isObj(x)) return { ok: false, error: `${what}[${i}] 要是对象 {key, oneLine, deps, estimate, fileGlobs}` };
    const key = typeof x.key === "string" ? x.key : "";
    if (!key) return { ok: false, error: `${what}[${i}] 缺 key` };
    if (typeof x.oneLine !== "string" || !x.oneLine.trim()) return { ok: false, error: `节点 ${key} 缺 oneLine（一句话说它做什么）` };
    if (x.deps !== undefined && !strArray(x.deps)) return { ok: false, error: `节点 ${key} 的 deps 要是字符串数组` };
    if (x.estimate !== undefined && typeof x.estimate !== "string") return { ok: false, error: `节点 ${key} 的 estimate 要是字符串` };
    if (!strArray(x.fileGlobs) || x.fileGlobs.length === 0 || x.fileGlobs.some((g) => !g.trim())) {
      return { ok: false, error: `节点 ${key} 必须带 fileGlobs（非空字符串数组，如 ["src/lib/foo*.ts"]）：并行车道和调度器的文件锁都靠它` };
    }
    out.push({ key, oneLine: x.oneLine, deps: (x.deps as string[] | undefined) ?? [], ...(x.estimate !== undefined ? { estimate: x.estimate } : {}), fileGlobs: x.fileGlobs });
  }
  return { ok: true, value: out };
}

/** 当前版的节点原样转成 CLI 输入（带绑的卡，否则 CLI 会当成换卡） */
const carry = (n: DagNode): NodeInput => ({
  key: n.key, taskId: n.taskId, oneLine: n.oneLine, deps: [...n.deps], estimate: n.estimate, ...(n.fileGlobs ? { fileGlobs: [...n.fileGlobs] } : {}),
});

/** plan_feature 对已有 DAG：给的是整版节点，同 key 的沿用已绑的卡；没列出来的进行中节点要走 rewrite_dag 的 cancel */
export function planOverExisting(cur: readonly DagNode[], next: readonly NodeInput[], phase: (n: DagNode) => NodePhase): Parsed<NodeInput[]> {
  const byKey = new Map(cur.map((n) => [n.key, n]));
  const listed = new Set(next.map((n) => n.key));
  const dropped = cur.filter((n) => !listed.has(n.key) && phase(n) === "active").map((n) => n.key);
  if (dropped.length) return { ok: false, error: `进行中的节点 ${dropped.join(", ")} 没在新列表里：取消进行中的节点要用 rewrite_dag 的 cancel 写原因` };
  return { ok: true, value: next.map((n) => ({ ...n, taskId: byKey.get(n.key)?.taskId ?? null })) };
}

export interface RewriteOps {
  add: NodeInput[];
  update: NodeInput[];
  remove: string[];
  /** 节点 key → 取消原因 */
  cancel: Record<string, string>;
}

/** rewrite_dag 的参数：至少一项改动；cancel 的原因非空 */
export function parseRewriteOps(args: Record<string, unknown>): Parsed<RewriteOps> {
  const add = args.add === undefined ? { ok: true as const, value: [] } : parseToolNodes(args.add, "add");
  if (!add.ok) return add;
  const update = args.update === undefined ? { ok: true as const, value: [] } : parseToolNodes(args.update, "update");
  if (!update.ok) return update;
  if (args.remove !== undefined && !strArray(args.remove)) return { ok: false, error: "remove 要是节点 key 的字符串数组" };
  if (args.cancel !== undefined && !isObj(args.cancel)) return { ok: false, error: "cancel 要是 {节点 key: 原因}" };
  const cancel: Record<string, string> = {};
  for (const [k, v] of Object.entries((args.cancel as Record<string, unknown> | undefined) ?? {})) {
    if (typeof v !== "string" || !v.trim()) return { ok: false, error: `cancel.${k} 要写取消原因（原话）` };
    cancel[k] = v.trim();
  }
  const ops = { add: add.value, update: update.value, remove: (args.remove as string[] | undefined) ?? [], cancel };
  if (!ops.add.length && !ops.update.length && !ops.remove.length && !Object.keys(cancel).length) return { ok: false, error: "没有改动：add / update / remove / cancel 至少给一项" };
  return { ok: true, value: ops };
}

/** 当前版 + 改动 → 下一版整版节点。进行中的节点只能经 cancel（带原因）移出，remove 只收没开始 / 计划中的 */
export function composeRewrite(cur: readonly DagNode[], ops: RewriteOps, phase: (n: DagNode) => NodePhase): Parsed<NodeInput[]> {
  const byKey = new Map(cur.map((n) => [n.key, n]));
  for (const k of [...ops.remove, ...Object.keys(ops.cancel), ...ops.update.map((n) => n.key)]) {
    if (!byKey.has(k)) return { ok: false, error: `当前版本里没有节点 ${k}` };
  }
  for (const n of ops.add) if (byKey.has(n.key)) return { ok: false, error: `节点 ${n.key} 已存在：改它用 update` };
  for (const k of ops.remove) {
    const p = phase(byKey.get(k) as DagNode);
    if (p === "active") return { ok: false, error: `节点 ${k} 进行中（${byKey.get(k)?.taskId}）：不能用 remove 删，要放进 cancel 并写原因` };
    if (p === "done") return { ok: false, error: `节点 ${k} 已完成，不能删` };
  }
  for (const k of Object.keys(ops.cancel)) {
    if (phase(byKey.get(k) as DagNode) !== "active") return { ok: false, error: `节点 ${k} 不是进行中的节点：没开始的用 remove` };
  }
  const gone = new Set([...ops.remove, ...Object.keys(ops.cancel)]);
  const updated = new Map(ops.update.map((n) => [n.key, n]));
  const kept = cur.filter((n) => !gone.has(n.key)).map((n) => {
    const u = updated.get(n.key);
    return u ? { ...u, taskId: n.taskId } : carry(n);
  });
  const next = [...kept, ...ops.add];
  const keys = new Set(next.map((n) => n.key));
  const dangling = next.filter((n) => n.deps.some((d) => !keys.has(d))).map((n) => `${n.key}→${n.deps.filter((d) => !keys.has(d)).join("/")}`);
  if (dangling.length) return { ok: false, error: `这些依赖指向被移出的节点，先用 update 改掉：${dangling.join(", ")}` };
  return { ok: true, value: next };
}
