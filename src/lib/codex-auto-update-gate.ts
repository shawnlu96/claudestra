/**
 * 网页「更新并重启」（bridge/runtime-update.ts）和 Codex 自动更新（lib/codex-auto-update.ts，跑在 launcher）共用的三样：
 * Codex 升级闸 prepareCodexUpdate、登录 shell 执行、整机更新锁。两边在不同进程，所以锁是文件锁（lib/file-lock.ts），
 * 不能是进程内变量——否则网页按钮和自动更新会同时跑 npm install -g。tests/runtime-update.test.ts、tests/codex-auto-update.test.ts。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchLatestCodex, probeCodexInstall } from "./codex-version.js";
import { currentCodexAcp, installCodexAcp, reconcileCodexAcp } from "./acp/install.js";
import { fetchAcpReleases, pickAdapterFor, rangeAllows } from "./acp/resolve.js";
import { identityLine, probeNpmCodexCompat, selectedCodexAdapter, type CodexCompat } from "./acp/codex-compat.js";
import { isStableVersion } from "./update-hints.js";
import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";

export type ShellResult = { ok: boolean; tail: string };
/** afterShell：命令成功后、重启前调（codex 用来切适配器指针） */
export type Prepared = { command: string; afterShell?: () => Promise<void> } | { status: number; error: string };

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const LOCK_PATH = join(STATE_DIR, "runtime-update.lock");
const HOLDER_FILE = "holder";

/**
 * 整机更新锁：拿不到不等，直接回占着的人（网页回 409，自动更新留给下一轮）。持有期间 file-lock 自己续租，
 * 持有者崩溃 3 分钟后可回收。label 写进锁目录给后来者看「正在为谁更新」。
 */
export async function tryUpdateLock(label: string, path = LOCK_PATH): Promise<{ release: () => void } | { holder: string }> {
  mkdirSync(dirname(path), { recursive: true });
  const h = await acquireLock(path, 0);
  if (!h) {
    let holder = "另一个更新";
    try { holder = readFileSync(join(path, HOLDER_FILE), "utf8") || holder; } catch { /* 对方刚抢到还没写名字 / 刚释放：用泛称 */ }
    return { holder };
  }
  try { writeFileSync(join(path, HOLDER_FILE), label); } catch (e) { console.warn(`⚠️ 更新锁写不进持有者名字（不影响加锁）:`, e); }
  return { release: h.release };
}

const CODEX_DEPS = {
  install: probeCodexInstall,
  latest: fetchLatestCodex,
  adapter: () => currentCodexAcp(),
  releases: () => fetchAcpReleases(),
  installAdapter: (rel: Parameters<typeof installCodexAcp>[0]) => installCodexAcp(rel),
  /** 按磁盘上此刻的 Codex 对账适配器（npm 成功后调；并发的 acp-install 也走它，谁最后对账谁说了算） */
  reconcile: () => reconcileCodexAcp({ codexVersion: async () => (await probeCodexInstall())?.version }),
  selected: selectedCodexAdapter,
  /** 自研适配器生效时：把这个版本装进临时目录、按 app-server 协议判兼容（codex-compat.ts） */
  compat: (version: string) => probeNpmCodexCompat(version, runInLoginShell),
};
export type CodexGateDeps = typeof CODEX_DEPS;

/** 自研适配器只认协议判定：兼容才装；不兼容 / 判不出都 409 带原因和组合身份。不对账上游指针：没有上游配套版本时那一步会失败、白白不重启 */
async function gateBySelfAdapter(latest: string, command: string, compat: (v: string) => Promise<CodexCompat>): Promise<Prepared> {
  const c = await compat(latest);
  if (c.verdict === "compatible") return { command };
  const why = c.verdict === "incompatible" ? "按 app-server 协议判定和自研 Codex 适配器不兼容" : "判不出和自研 Codex 适配器是否兼容";
  const more = c.reasons.length > 5 ? `；另有 ${c.reasons.length - 5} 条` : "";
  const who = c.identity ? `；${identityLine(c.identity)}` : "";
  return { status: 409, error: `npm 上的 Codex ${latest} ${why}，没更新：${c.reasons.slice(0, 5).join("；")}${more}${who}` };
}

/**
 * 装的是**这一刻查到的** latest 且钉死版本号，不写 @latest：查完到装之间 npm 发了新版，也不会装上没核对过配套的那个。
 * latest 不配当前适配器时，先把能配它的最新适配器装进自己的版本目录（不切指针，装不上就 Codex 也不动）。不论哪个分支，
 * npm 成功后都按磁盘上此刻的 Codex 对账（reconcileCodexAcp，在锁里切指针），对账失败回 500 不重启，成功才重启。对账前有一个很短的错配窗口（旧适配器 + 新 Codex），
 * 这期间别的 ACP agent 恰好重启会撞上，已知且可接受；其余在跑的 ACP agent 不动，下次重启自然用上新指针和新 Codex。
 * npm 上也找不到能配的适配器就 409（网页此时本来就不给按钮）。适配器状态 broken 也 409：不知道现在跑的是哪个，先 acp-install。
 * 以上都是上游 codex-acp 生效时；自研适配器生效时改走 gateBySelfAdapter。
 */
export async function prepareCodexUpdate(over: Partial<CodexGateDeps> = {}): Promise<Prepared> {
  const d = { ...CODEX_DEPS, ...over };
  const i = await d.install();
  if (!i) return { status: 400, error: "登录 shell 的 PATH 里找不到 codex" };
  if (!i.npm) return { status: 400, error: "Codex 不是 npm 全局安装（brew 等），请用原来的安装方式手动更新" };
  const latest = await d.latest().catch((e) => (console.warn("⚠️ [codex-update] 查 npm latest 失败:", e), undefined));
  if (!latest) return { status: 502, error: "查不到 npm 上 @openai/codex 的最新版本，稍后再试" };
  if (!isStableVersion(latest)) return { status: 409, error: `npm 上的 Codex ${latest.slice(0, 40)} 不是正式版，不替你装` };
  const command = `npm install -g @openai/codex@${latest}`;
  if (d.selected() === "self") return gateBySelfAdapter(latest, command, d.compat);
  // npm 成功后一律按磁盘上的 Codex 对账：快速分支也要，npm 期间并发的 acp-install 可能按旧 Codex 切过指针。
  // 那一刻仍没装任何适配器就不对账（没有 ACP agent 能跑，不替 tmux-only 的机器下载适配器）
  const afterShell = async () => {
    if (d.adapter() === null) return;
    const r = await d.reconcile();
    if (!r.ok) throw new Error(r.error);
  };
  const cur = d.adapter();
  if (cur === "broken") return { status: 409, error: "codex-acp 的版本指针或标记坏了，先跑一次 manager acp-install 再更新 Codex" };
  if (!cur || rangeAllows(cur.codexRange, latest)) return { command, afterShell };
  const rel = pickAdapterFor(await d.releases().catch((e) => (console.warn("⚠️ [codex-update] 查 codex-acp 版本失败:", e), [])), latest);
  if (!rel) return { status: 409, error: `npm 上的 Codex ${latest} 不在 codex-acp ${cur.version} 的配套范围（${cur.codexRange}），等适配器升级后再更新` };
  const got = await d.installAdapter(rel);
  if (!got.ok) return { status: 502, error: `先装配套的 codex-acp ${rel.version} 失败，Codex 没动：${got.error}` };
  return { command, afterShell };
}

export async function runInLoginShell(cmd: string): Promise<ShellResult> {
  const proc = Bun.spawn([process.env.SHELL || "/bin/zsh", "-ilc", cmd], {
    cwd: process.env.HOME,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
  });
  const timer = setTimeout(() => proc.kill(), UPDATE_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  // 去 ANSI 颜色码：NO_COLOR 不一定被每个子进程尊重
  const tail = `${out}\n${err}`.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter(Boolean).slice(-6).join("\n");
  return { ok: code === 0, tail };
}
