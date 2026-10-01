/**
 * 出借 worker 被 kill 前留现场（i28-R5b）：窗口里每个 pane 最近 2000 行存到 `logs/lend/<agent>/pane-<UTC>.txt`。
 * 宿主自停的原因只打在 pane 上，kill 窗口后就没了；存下来下次停能直接读到。
 * 存档是旁路：任何失败只记日志、绝不抛，kill 与收尾的判定和顺序一概不动（tests/lend-pane-archive.test.ts 钉住）。
 * 文件 0600、目录 0700：pane 里可能有出借方仓库内容与命令输出，只给本用户看。
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { LOG_DIR } from "./log-paths.js";
import { tmuxRawStrict, windowTarget } from "./tmux-helper.js";

const LEND_PANE_ROOT = join(LOG_DIR, "lend");
export const PANE_ARCHIVE_LINES = 2000;
export const PANE_ARCHIVE_KEEP = 20;
const TMUX_TIMEOUT_MS = 5_000; // 卡住的 tmux 不能把 kill 拖 15s × pane 数
const ARCHIVE_FILE_RE = /^pane-.+\.txt$/;
/** 首字符不许是点：挡掉 `.` `..` 与隐藏名；不含 `/` `\` NUL，拼不出子路径 */
const SAFE_AGENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export interface PaneInfo { id: string; index: string; command: string }

export interface PaneArchiveFs {
  /** 建 root 与 dir（0700），且两者都必须是真目录、不是软链 */
  ensureDir(root: string, dir: string): void;
  /** 只新建（O_EXCL，不跟随已存在的软链），0600 */
  writeNew(path: string, data: string): void;
  list(dir: string): string[];
  remove(path: string): void;
}

export interface PaneArchiveDeps {
  root: string;
  listPanes(agent: string): Promise<PaneInfo[]>;
  capture(paneId: string, lines: number): Promise<string>;
  fs: PaneArchiveFs;
  now(): number;
  log(m: string): void;
}

export type PaneArchiveResult = { ok: true; path: string; panes: number } | { ok: false; reason: string };

/** agent 名不合规、或 resolve 后不在 root 之下 → null（不存档） */
export function lendPaneDir(root: string, agent: string): string | null {
  if (!SAFE_AGENT_RE.test(agent)) return null;
  const base = resolve(root);
  const dir = resolve(base, agent);
  return dir.startsWith(base + sep) ? dir : null;
}

/** UTC 时间戳，字典序 = 时间序：20261001T044030240Z */
export function paneArchiveName(nowMs: number): string {
  return `pane-${new Date(nowMs).toISOString().replace(/[-:.]/g, "")}.txt`;
}

/** 按名字（时间戳）排序，保留最新 keep 份，返回要删的文件名 */
export function prunePlan(names: string[], keep = PANE_ARCHIVE_KEEP): string[] {
  const own = names.filter((n) => ARCHIVE_FILE_RE.test(n)).sort();
  return own.slice(0, Math.max(0, own.length - keep));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function renderPaneArchive(agent: string, nowMs: number, panes: Array<PaneInfo & { text: string }>): string {
  const head = [`# lend worker ${agent} 现场 @ ${new Date(nowMs).toISOString()}`, `# panes: ${panes.length}`, ""];
  const body = panes.flatMap((p) => [`=== pane ${p.id} (index ${p.index}, ${p.command || "?"}) ===`, p.text, ""]);
  return [...head, ...body].join("\n");
}

async function capturePanes(deps: PaneArchiveDeps, panes: PaneInfo[]): Promise<Array<PaneInfo & { text: string }>> {
  const out: Array<PaneInfo & { text: string }> = [];
  for (const p of panes) {
    // 单个 pane 读失败只记在存档里，其余 pane 照存：多留一点现场总比全丢强
    const text = await deps.capture(p.id, PANE_ARCHIVE_LINES).catch((e) => `（capture 失败：${errText(e)}）`);
    out.push({ ...p, text });
  }
  return out;
}

function prune(deps: PaneArchiveDeps, dir: string): void {
  try {
    for (const n of prunePlan(deps.fs.list(dir))) deps.fs.remove(join(dir, n));
  } catch (e) {
    deps.log(`现场存档清理旧文件失败（${dir}）：${errText(e)}；新存档已写，下次再清`);
  }
}

/** 永不抛：失败返回 {ok:false} 并记日志 */
export async function archiveLendPane(agent: string, deps: PaneArchiveDeps = defaultPaneArchiveDeps()): Promise<PaneArchiveResult> {
  const fail = (reason: string): PaneArchiveResult => {
    deps.log(`kill 前存 ${agent} 现场失败：${reason}；kill 照常`);
    return { ok: false, reason };
  };
  try {
    const dir = lendPaneDir(deps.root, agent);
    if (!dir) return fail("agent 名不合规，拼不出 logs/lend 下的路径");
    const panes = await deps.listPanes(agent);
    if (panes.length === 0) return fail("窗口里没有 pane（窗口已不在）");
    const captured = await capturePanes(deps, panes);
    const now = deps.now();
    deps.fs.ensureDir(resolve(deps.root), dir);
    const path = join(dir, paneArchiveName(now));
    deps.fs.writeNew(path, renderPaneArchive(agent, now, captured));
    prune(deps, dir);
    deps.log(`kill 前已存 ${agent} 现场（${panes.length} 个 pane）：${path}`);
    return { ok: true, path, panes: panes.length };
  } catch (e) {
    return fail(errText(e));
  }
}

/**
 * 包一层 kill：先存档、再原样调用 kill 并原样返回。archive 按约定不抛，这里再兜一层，
 * 防以后改坏了让存档挡住 kill —— kill 挡住 = 出借 worker 停不掉、单子收不了尾。
 */
export function withPaneArchive<R>(
  kill: (name: string) => Promise<R>,
  archive: (name: string) => Promise<unknown> = (n) => archiveLendPane(n),
  log: (m: string) => void = (m) => console.error(`[lend] ${m}`),
): (name: string) => Promise<R> {
  return async (name) => {
    try { await archive(name); } catch (e) { log(`kill 前存 ${name} 现场抛错：${errText(e)}；kill 照常`); }
    return kill(name);
  };
}

function assertRealDir(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path} 不是真目录（软链或文件），不往里写`);
}

export const nodePaneArchiveFs: PaneArchiveFs = {
  ensureDir(root, dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const d of [root, dir]) { assertRealDir(d); chmodSync(d, 0o700); } // mkdir 的 mode 受 umask 影响、已存在的目录不改 mode
  },
  writeNew(path, data) {
    writeFileSync(path, data, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
  },
  list: (dir) => readdirSync(dir),
  remove: (path) => unlinkSync(path),
};

export function parsePaneList(raw: string): PaneInfo[] {
  return raw.split("\n").filter((l) => l.trim()).map((l) => {
    const [id = "", index = "", command = ""] = l.split("\t");
    return { id: id.trim(), index: index.trim(), command: command.trim() };
  }).filter((p) => p.id);
}

function defaultPaneArchiveDeps(): PaneArchiveDeps {
  return {
    root: LEND_PANE_ROOT,
    // list-panes 而不是 display-message：窗口不在时后者会退回当前窗口（tmux-helper windowTarget 注释）
    listPanes: async (agent) => parsePaneList(await tmuxRawStrict(
      ["list-panes", "-t", windowTarget(agent), "-F", "#{pane_id}\t#{pane_index}\t#{pane_current_command}"], { timeoutMs: TMUX_TIMEOUT_MS })),
    capture: (paneId, lines) => tmuxRawStrict(["capture-pane", "-t", paneId, "-p", "-J", "-S", `-${lines}`], { timeoutMs: TMUX_TIMEOUT_MS }),
    fs: nodePaneArchiveFs,
    now: () => Date.now(),
    log: (m) => console.error(`[lend] ${m}`),
  };
}
