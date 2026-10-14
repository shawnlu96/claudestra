/**
 * merge-arch-SKIPAUTO1 · 效果点清单（scheduler-v2-skip-effects.ts）纯计数改动的机器核准，恢复键 skipEffectsAutoScope（缺省 observe）。
 * 卡的交付把清单列成规格外文件时，按交付绑定的 PR base（merge base）与 exact head 读 Git 对象：清单只改了既有条目的计数字符串
 * （skip-effects-auto-scope-scan.ts countOnlyChanges），且 head 源码经本进程受信扫描器（passGraph / effectSites）的结果与 head 清单逐项相等，
 * 才算核准。PR 的源码只当字符串读，不 import、不执行；PR 改了扫描规则或判定器、对象缺失、二进制、head 漂移、私仓，一律不核准并写原因。
 * on 时只给这一个文件一条窄例外：不扩 fileGlobs、不占锁、不放宽别的规格外文件；off / observe 不产生授权。
 * tests/skip-effects-auto-scope.test.ts。
 */
import { countOnlyChanges, effectSites, isGate, parseInventory, passRoots, stripComments, valueImports, type CountOnlyChange, EFFECTS }
  from "./skip-effects-auto-scope-scan.js";
import { SCOPE_DIFF_MAX_BYTES, SCOPE_OBJECT_MAX_BYTES, SCOPE_OBJECT_READER, type ScopeDiff } from "./order-deliver-scope-git.js";
import type { RecoveryMode } from "./recovery-policy.js";

export const SKIP_EFFECTS_INVENTORY = "src/lib/scheduler-v2-skip-effects.ts";
const LIB_DIR = "src/lib";
/** 扫描规则与判定器本身：PR 碰了其中任何一个，受信扫描不再代表 PR 的 CI，回人工 */
export const JUDGE_GLOBS = ["scripts/skip-effects.ts", "src/lib/scheduler-v2-skip-paths.ts", "src/lib/skip-effects-auto-scope*.ts",
  "src/lib/order-deliver-scope*.ts", "src/lib/order-wire-file-scope.ts", "tests/shared-ledger-v2-stage2-skip-paths.test.ts"];
const READ_CONCURRENCY = 8;

/**
 * 规则格式号：读取、解析、判定任何一处实现改了都要升（指纹只能自动覆盖扫描规则与起点）。
 * 2：第 1、2 轮的读取会截断 / 有损解码（r1 object-cap-1、r2 byte-integrity-1），那两版写下的 /1 证据一律不沿用。
 * 3：变更文件清单须完整读到才核（r3 object-cap-1：截断的清单会漏掉扫描器改动），/2 证据不沿用。
 */
const RULE_NAME = "skip-effects-auto-scope/3";
/**
 * 规则版本：格式号 + 本进程扫描规则、起点、判定路径、对象读取实现版本与上限的指纹；任何一项变了，旧证据出单时降级人工
 * （只进事件数据，审查单只写格式号，免得外发闸当随机串）
 */
export const AUTO_SCOPE_RULE = `${RULE_NAME}:${Bun.hash(JSON.stringify([Object.entries(EFFECTS).map(([k, r]) => [k, String(r)]),
  passRoots(), JUDGE_GLOBS, SCOPE_OBJECT_READER, SCOPE_OBJECT_MAX_BYTES, SCOPE_DIFF_MAX_BYTES])).toString(16)}`;

export interface AutoScopeEntry extends CountOnlyChange { scanned: string }
export interface SkipEffectsAutoScope {
  path: string;
  /** PR base 与比对用的 merge base（diff 的同一端） */
  base: string;
  mergeBase: string | null;
  head: string;
  rule: string;
  mode: RecoveryMode;
  /** 机器核对通过（与模式无关）：observe 下即「本可自动核准」 */
  eligible: boolean;
  /** 正式授权：只有 on 且核对通过 */
  granted: boolean;
  entries: AutoScopeEntry[];
  reasons: string[];
  /** 读取 / 解析失败的原始报错（只进事件数据：git 报错可能带完整 SHA，外发闸会拒整单） */
  error?: string;
}

const matches = (path: string, globs: string[]) => globs.some((g) => new Bun.Glob(g).match(path));

/**
 * 纯判定：两版清单原文 + head 受信扫描结果 → 变更条目或拒绝原因。计数改动须与扫描值逐项相等，扫描与 head 清单须整表相等
 * （无未登记、无多余条目）；登记重复由 parseInventory 拒。
 */
export function judgeCountOnly(baseText: string, headText: string, scan: Map<string, string>): { entries: AutoScopeEntry[]; reasons: string[] } {
  const cmp = countOnlyChanges(baseText, headText);
  if (!cmp.ok) return { entries: [], reasons: [cmp.reason] };
  const registered = parseInventory(headText), reasons: string[] = [];
  const entries = cmp.changed.map((c) => ({ ...c, scanned: scan.get(c.file) ?? "-" }));
  for (const e of entries) if (e.to !== e.scanned) reasons.push(`${e.file} 计数 "${e.to}" 与受信扫描 "${e.scanned}" 不符`);
  const unregistered = [...scan.keys()].filter((f) => !registered.has(f)).sort();
  const stale = [...registered.keys()].filter((f) => !scan.has(f)).sort();
  const off = [...registered].filter(([f, c]) => scan.has(f) && scan.get(f) !== c && !entries.some((e) => e.file === f)).map(([f]) => f).sort();
  if (unregistered.length) reasons.push(`未登记的效果文件：${unregistered.join("、")}`);
  if (stale.length) reasons.push(`扫描里没有的登记：${stale.join("、")}`);
  if (off.length) reasons.push(`未改动却与扫描不符的登记：${off.join("、")}`);
  return { entries, reasons };
}

async function limited<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) await f(items[next++]!); }));
}

/**
 * head 的调度轮可达图：与受信 passGraph 同一套起点 / 去注释 / 取 import / 去 gate 文件，只是按需异步取 blob（PR 源码只当字符串），
 * 每个文件只去一次注释；再交给受信 effectSites 数效果点。
 */
export async function headScan(objects: NonNullable<ScopeDiff["objects"]>, head: string): Promise<Map<string, string>> {
  const prefix = `${LIB_DIR}/`;
  const tree = new Set((await objects.list(head, LIB_DIR)).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .map((p) => p.slice(prefix.length)));
  const stripped = new Map<string, string>();
  let frontier = passRoots();
  while (frontier.length) {
    const need = [...new Set(frontier)].filter((f) => !stripped.has(f));
    await limited(need, READ_CONCURRENCY, async (f) => {
      // 起点缺了也算对象缺失（passGraph 对起点不查 exists，读不到就抛）
      if (!tree.has(f)) throw new Error(`head 缺 ${prefix}${f}`);
      const text = await objects.show(head, `${prefix}${f}`);
      if (text.includes("\0")) throw new Error(`${prefix}${f} 是二进制`);
      stripped.set(f, stripComments(text));
    });
    frontier = need.flatMap((f) => valueImports(stripped.get(f)!)).filter((d) => tree.has(d) && !stripped.has(d));
  }
  return effectSites([...stripped].map(([name, text]) => ({ name, text })).filter((f) => !isGate(f.name)));
}

/**
 * 交付 diff 里清单是规格外文件时核一次；清单不在 diff 或已在 fileGlobs 内返回 null（无需例外）。永不抛出：任何读不到都落成拒绝原因。
 * mode 为 off 时调用方不调本函数。
 */
export async function checkSkipEffectsAutoScope(diff: ScopeDiff, outsidePaths: string[], head: string,
  opts: { mode: RecoveryMode; privateRepo: boolean }): Promise<SkipEffectsAutoScope | null> {
  const file = diff.files.find((f) => f.path === SKIP_EFFECTS_INVENTORY);
  if (!file || !outsidePaths.includes(SKIP_EFFECTS_INVENTORY)) return null;
  const out: SkipEffectsAutoScope = { path: SKIP_EFFECTS_INVENTORY, base: diff.base, mergeBase: null, head, rule: AUTO_SCOPE_RULE, mode: opts.mode,
    eligible: false, granted: false, entries: [], reasons: [] };
  const judge = diff.files.map((f) => f.path).filter((p) => matches(p, JUDGE_GLOBS));
  if (opts.privateRepo) out.reasons.push("私仓卡：读不到本仓完整调度图");
  else if (diff.filesComplete !== true) out.reasons.push("变更文件清单未能完整读到，无法证明本 PR 没改扫描规则 / 判定器");
  else if (judge.length) out.reasons.push(`本 PR 改了扫描规则 / 判定器（${judge.join("、")}）`);
  else if (file.added === null || file.deleted === null) out.reasons.push("清单 diff 是二进制");
  else if (!diff.objects) out.reasons.push("读不到 Git 对象");
  if (out.reasons.length) return out;
  const objects = diff.objects!;
  try {
    out.mergeBase = await objects.mergeBase(diff.base, head);
    const [baseText, headText] = await Promise.all([objects.show(out.mergeBase, SKIP_EFFECTS_INVENTORY), objects.show(head, SKIP_EFFECTS_INVENTORY)]);
    if (baseText.includes("\0") || headText.includes("\0")) throw new Error("清单是二进制");
    // 结构不是纯计数就不必扫：先用纯比较拒掉
    const cmp = countOnlyChanges(baseText, headText);
    if (!cmp.ok) out.reasons.push(cmp.reason);
    else {
      const r = judgeCountOnly(baseText, headText, await headScan(objects, head));
      out.entries = r.entries; out.reasons.push(...r.reasons);
    }
    const now = await objects.prHead();
    if (now !== head) out.reasons.push("PR head 已漂移，按新 head 重核");
  } catch (e) {
    out.reasons.push("Git 对象读取或解析失败");
    out.error = (e as Error).message.slice(0, 1000);
  }
  out.eligible = !out.reasons.length && out.entries.length > 0;
  out.granted = out.eligible && opts.mode === "on";
  return out;
}

/**
 * 出单时的视图：登记时的核对结果（eligible 与模式无关）配上当前模式；只有当前 on、核对通过、规则版本与本进程一致才是正式授权。
 * 重启后换了扫描器（规则指纹变了）不沿用旧核准，回人工。
 */
export function autoScopeNow(a: SkipEffectsAutoScope, mode: RecoveryMode): SkipEffectsAutoScope {
  const stale = a.eligible && a.rule !== AUTO_SCOPE_RULE;
  return { ...a, mode, granted: a.eligible && !stale && mode === "on",
    reasons: stale ? [...a.reasons, "登记后本机扫描规则版本已变，旧核对结果不沿用"] : a.reasons };
}

/** 审查单里的说明：on 才写；核准写明免单独批准且只覆盖这一个文件，未核准写原因、照原规则 */
export function describeAutoScope(a: SkipEffectsAutoScope): string | null {
  if (a.mode !== "on") return null;
  if (!a.granted) {
    const why = a.reasons.join("；").replace(/\b[0-9a-f]{40}\b/g, "<sha>");
    return `${JSON.stringify(a.path)} 未获纯计数自动例外（skipEffectsAutoScope=on，规则 ${RULE_NAME}）：${why}；按原规格外规则处理。`;
  }
  const list = a.entries.map((e) => `${e.gate}/${e.file} "${e.from}"→"${e.to}"`).join("，");
  return `${JSON.stringify(a.path)} 纯计数机器核准，无需再 ask PM（skipEffectsAutoScope=on，规则 ${RULE_NAME}；只改既有条目计数且与受信扫描逐项相等：${list}）。`
    + "本例外只覆盖这一个文件，不扩 fileGlobs，其他规格外文件照常判断。";
}

/** 派单文件范围说明：on 且卡的 fileGlobs 不含清单时补的一句，口径与交付核准一致 */
export const AUTO_SCOPE_ORDER_NOTE = `窄例外（skipEffectsAutoScope=on）：${SKIP_EFFECTS_INVENTORY} 只改既有条目的计数字符串、且与本仓扫描值逐项相等时，`
  + "可不另行登记直接改，交付时机器核准；增删条目、移组、改注释或其他字节仍须 PM 精准例外，本例外不放宽其他文件。";
