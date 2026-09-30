/**
 * codex-acp 适配器的安装（`manager acp-install`、readiness 的自动安装、网页「更新并重启」）。GitHub release 上没有附件，
 * 所以直接下 npm registry 上的包文件，只解出 dist/index.js（esbuild 打好的单文件）放进状态目录的 codex-acp-<版本>/，
 * 用我们自己的 bun 跑；设了 CODEX_PATH 时它不加载 @openai/codex，所以不进 package.json、不装依赖。
 * - 信任链：版本和 sha512 都取自 registry 元数据（resolve.ts），下载后按 dist.integrity 验包，对不上就拒装。信任 registry
 *   是因为 Codex 本身就是 `npm install -g @openai/codex` 从同一个 registry 装的——registry 若被攻破，Codex 早已失守，
 *   写死 sha 只会让每个 Codex 小版本都要改代码发版。改成写死会让「自动跟随」失效；改成别的源要另起信任理由。
 * - 当前用哪个版本：状态目录 acp/current.json 指针（tmp+rename 原子切换），旧版本目录都留着，指针指回去即回退。
 *   适配器处于什么状态只由 currentCodexAcp 一处判定（含入口哈希），其余调用方都读它，不各判各的。
 * - 没有指针、而且状态目录里只有 2.0.0 这一个版本目录（这套机制之前唯一的版本）才认作老安装，配套范围 ^0.158.0。
 * - 切指针只经 reconcileCodexAcp：在锁里按磁盘上此刻的 Codex 对账，谁最后对账谁说了算，最终一定配套或明确报错。
 * tests/acp-install.test.ts。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { statePath } from "../paths.js";
import { acquireLock } from "../file-lock.js";
import { expectedTarball, fetchAcpReleases, pickAdapterFor, rangeAllows, type AcpRelease, type MetaFetch } from "./resolve.js";

const LEGACY = { version: "2.0.0", codexRange: "^0.158.0" };
const ENTRY_IN_TAR = "package/dist/index.js";
/** 包文件 2.0.x 约 270KB、解开约 1.6MB；超过这两个数一定不是我们要的那个，不读完 / 不解完 */
const MAX_TARBALL_BYTES = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const MARKER = "installed.json";
const POINTER = "current.json";

const defaultRoot = () => statePath("acp");
const versionDir = (version: string, root = defaultRoot()) => join(root, `codex-acp-${version}`);
const entryOf = (version: string, root?: string) => join(versionDir(version, root), "index.js");

export const sha256Hex = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");
export const sha512Integrity = (buf: Uint8Array) => `sha512-${createHash("sha512").update(buf).digest("base64")}`;

/**
 * 从 tar（ustar）里取一个文件的内容；找不到返回 null。只认普通文件、名字完全相等——不按名字往磁盘上写任何东西，
 * 所以也没有路径穿越的问题。
 */
export function extractTarEntry(tar: Uint8Array, name: string): Uint8Array | null {
  const dec = new TextDecoder();
  const field = (off: number, len: number) => dec.decode(tar.subarray(off, off + len)).replace(/\0.*$/s, "");
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return null; // 结尾的空块
    const prefix = field(off + 345, 155);
    const full = prefix ? `${prefix}/${field(off, 100)}` : field(off, 100);
    const size = parseInt(field(off + 124, 12).trim() || "0", 8);
    const type = field(off + 156, 1);
    if (!Number.isFinite(size) || size < 0) return null;
    const body = off + 512;
    if (full === name && (type === "0" || type === "")) return body + size <= tar.length ? tar.slice(body, body + size) : null;
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

type Marker = { version?: string; integrity?: string; codexRange?: string; entrySha256?: string };
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // 没有 / 坏了：由 currentCodexAcp 统一归到 broken 或 null
  }
}

/** 同目录唯一的临时名：两个进程（manager 与 bridge）同时装同一版本时不会互相 rename 走对方的文件 */
export const tmpName = (path: string) => `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = tmpName(path);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

const STABLE = /^\d+\.\d+\.\d+$/;
interface CurrentAcp { version: string; codexRange: string; path: string }
/** null = 什么都没装过；"broken" = 有东西但不可信（指针坏、多版本却没指针、标记 / 入口 / 哈希对不上） */
export type AdapterNow = CurrentAcp | null | "broken";

/** 状态目录里的版本目录（codex-acp-x.y.z） */
function versionDirs(root: string): string[] {
  try {
    return readdirSync(root).map((n) => /^codex-acp-(\d+\.\d+\.\d+)$/.exec(n)?.[1]).filter((v): v is string => !!v);
  } catch {
    return []; // 状态目录还没建：什么都没装
  }
}

/** 一个版本目录装得完整、没被改过：标记对、范围在、入口在且哈希一致（1.5MB 算一次不到 10ms） */
function verifiedVersion(version: string, root: string): CurrentAcp | null {
  const m = readJson<Marker>(join(versionDir(version, root), MARKER));
  const codexRange = m?.codexRange ?? (version === LEGACY.version ? LEGACY.codexRange : undefined);
  const path = entryOf(version, root);
  if (m?.version !== version || !codexRange) return null; // 缺 entrySha256 时下面的哈希比对不会通过
  try {
    return existsSync(path) && sha256Hex(readFileSync(path)) === m.entrySha256 ? { version, codexRange, path } : null;
  } catch (e) {
    console.warn(`⚠️ [acp-install] 读 ${path} 失败，按不可信处理:`, e);
    return null;
  }
}

/**
 * 适配器此刻的状态——唯一判定处：宿主起适配器、readiness、横幅、codex-update 端点、doctor 都读它。
 * 有指针就只看指针指的版本；没有指针时，只有状态目录里恰好只剩 2.0.0 一个版本目录才认作老安装，别的版本目录在就是
 * 指针丢了（不回退旧版）。任何一环对不上都是 broken：调用方一律 fail-closed，由 acp-install / readiness 对账修好。
 */
export function currentCodexAcp(root = defaultRoot()): AdapterNow {
  const ptr = join(root, POINTER);
  let version = LEGACY.version;
  if (existsSync(ptr)) {
    const v = readJson<{ version?: unknown }>(ptr)?.version;
    if (typeof v !== "string" || !STABLE.test(v)) return "broken";
    version = v;
  } else {
    const dirs = versionDirs(root);
    if (!dirs.length) return null;
    if (dirs.length !== 1 || dirs[0] !== LEGACY.version) return "broken";
  }
  return verifiedVersion(version, root) ?? "broken";
}

/**
 * 本机 codex 和当前适配器配套（宿主告警、网页提示、doctor 共用）。没装过适配器 = 没有要配的，不拦（之后 readiness 自动装时
 * 按本机 codex 挑版本）；broken 一律算不配套。
 */
export function codexPairsWithAdapter(codexVersion: string | undefined, root?: string): boolean {
  const cur = currentCodexAcp(root);
  return cur === "broken" ? false : !cur || rangeAllows(cur.codexRange, codexVersion);
}

export type Installed = { ok: true; path: string; version: string; codexRange: string } | { ok: false; hint: string };
const FIX = "跑一次 `bun src/manager.ts acp-install`";
export const BROKEN_HINT = `codex-acp 的版本指针、标记或入口文件坏了（或被改过）：${FIX}`;

/** currentCodexAcp 换成「能不能起」的说法 */
export function codexAcpInstalled(root?: string): Installed {
  const cur = currentCodexAcp(root);
  if (cur === "broken") return { ok: false, hint: BROKEN_HINT };
  return cur ? { ok: true, ...cur } : { ok: false, hint: `codex-acp 没装：${FIX}` };
}

/** 直接写指针，不查不锁：只给 reconcileCodexAcp（在锁里）和单测用 */
export function useCodexAcp(version: string, root = defaultRoot()): void {
  mkdirSync(root, { recursive: true });
  writeAtomic(join(root, POINTER), JSON.stringify({ version, at: new Date().toISOString() }) + "\n");
}

const pointerLock = async (root: string) => {
  mkdirSync(root, { recursive: true });
  return acquireLock(join(root, ".pointer.lock"), 60_000);
};

/**
 * 老 2.0.0 安装还没有指针时，先把它写成显式指针再装别的版本：否则多出一个版本目录，没有指针的老安装就判成 broken，
 * 这期间重启的 ACP agent 会起不来。
 */
async function pinLegacy(root: string): Promise<void> {
  if (existsSync(join(root, POINTER))) return;
  const lock = await pointerLock(root);
  if (!lock) throw new Error("等 codex-acp 指针锁超时");
  try {
    const cur = currentCodexAcp(root);
    if (cur && cur !== "broken" && !existsSync(join(root, POINTER))) useCodexAcp(cur.version, root);
  } finally {
    lock.release();
  }
}

export type InstallResult = { ok: true; path: string; reused: boolean; version: string; codexRange: string } | { ok: false; error: string };
type TarballFetch = (url: string) => Promise<Response>;
export interface InstallDeps {
  fetch?: TarballFetch;
  fetchMeta?: MetaFetch;
  root?: string;
}
const defaultFetch: TarballFetch = (u) => fetch(u, { signal: AbortSignal.timeout(60_000) });

/** 边读边计数：content-length 超限直接拒，没给长度的读到超限就停，内存里最多多一个分块 */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) throw new Error(`包文件 ${declared} 字节，远超预期，拒装`);
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of res.body ?? []) {
    n += c.length;
    if (n > max) throw new Error(`包文件超过 ${max} 字节，远超预期，拒装`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

type Fetched = { ok: true; tgz: Uint8Array } | { ok: false; error: string };
async function download(url: string, f: TarballFetch): Promise<Fetched> {
  try {
    const res = await f(url);
    if (!res.ok) return { ok: false, error: `下载 ${url} 失败：HTTP ${res.status}` };
    return { ok: true, tgz: await readCapped(res, MAX_TARBALL_BYTES) };
  } catch (e) {
    return { ok: false, error: `下载 ${url} 失败：${e instanceof Error ? e.message : e}` };
  }
}

/** 把一个版本装进它自己的目录，**不切指针**（切指针只经 reconcileCodexAcp） */
export async function installCodexAcp(rel: AcpRelease, deps: InstallDeps = {}): Promise<InstallResult> {
  if (rel.tarball !== expectedTarball(rel.version)) return { ok: false, error: `tarball 地址不是 ${expectedTarball(rel.version)}，拒装` };
  const root = deps.root ?? defaultRoot();
  const dir = versionDir(rel.version, root);
  const have = verifiedVersion(rel.version, root);
  const m = readJson<Marker>(join(dir, MARKER));
  if (have && m?.integrity === rel.integrity && have.codexRange === rel.codexRange) return { ok: true, reused: true, ...have };
  const got = await download(rel.tarball, deps.fetch ?? defaultFetch);
  if (!got.ok) return got;
  const integrity = sha512Integrity(got.tgz);
  if (integrity !== rel.integrity) return { ok: false, error: `integrity 与 registry 公布的对不上，拒装（期望 ${rel.integrity}，实际 ${integrity}）` };
  let entry: Uint8Array | null;
  try {
    entry = extractTarEntry(gunzipSync(got.tgz, { maxOutputLength: MAX_UNPACKED_BYTES }), ENTRY_IN_TAR);
  } catch (e) {
    return { ok: false, error: `解包失败（或解开超过 ${MAX_UNPACKED_BYTES} 字节）：${e instanceof Error ? e.message : e}` };
  }
  if (!entry) return { ok: false, error: `包里没有 ${ENTRY_IN_TAR}` };
  try {
    if (rel.version !== LEGACY.version) await pinLegacy(root);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  mkdirSync(dir, { recursive: true });
  const dest = entryOf(rel.version, root);
  writeAtomic(dest, entry);
  const marker = { version: rel.version, integrity: rel.integrity, codexRange: rel.codexRange, entrySha256: sha256Hex(entry), installedAt: new Date().toISOString() };
  writeAtomic(join(dir, MARKER), JSON.stringify(marker) + "\n");
  return { ok: true, reused: false, version: rel.version, codexRange: rel.codexRange, path: dest };
}

/**
 * 能配 codexVersion 的最新适配器：先问 registry 并装好；registry 不通、或最新候选下载 / 安装失败，就在本地已装、完好
 * （verifiedVersion）且配套的版本里挑最高的——codex-update 预装过的那个就在这里，npm 之后临时下不动新包也不会留下错配。
 */
async function prepareFor(codexVersion: string, deps: InstallDeps, root: string): Promise<InstallResult> {
  let failure = "";
  try {
    const remote = pickAdapterFor(await fetchAcpReleases(deps.fetchMeta), codexVersion);
    const got = remote ? await installCodexAcp(remote, deps) : null;
    if (got?.ok) return got;
    if (got) failure = got.error;
  } catch (e) {
    failure = `查 codex-acp 版本失败：${e instanceof Error ? e.message : e}`;
  }
  const local = versionDirs(root).map((v) => verifiedVersion(v, root)).filter((x): x is CurrentAcp => !!x && rangeAllows(x.codexRange, codexVersion))
    .sort((a, b) => Bun.semver.order(b.version, a.version))[0];
  if (local) return { ok: true, reused: true, ...local };
  return { ok: false, error: failure || `npm 上没有能配 codex ${codexVersion} 的 codex-acp 正式版` };
}

export interface ReconcileDeps extends InstallDeps {
  /** 磁盘上此刻装着的 codex 版本（x.y.z）；每轮对账都重新探 */
  codexVersion: () => Promise<string | undefined>;
}

/**
 * 让适配器和**磁盘上此刻的** Codex 配套：挑版本、装好（锁外，要联网），再在指针锁里重探一次 Codex——版本没变才切，
 * 变了（别的进程刚升完 Codex）就按新版本再来一轮。幂等：已配套就不动。acp-install、readiness、codex-update 收尾都走这里，
 * 所以并发时最后一个对账的一方看到的是最终的 Codex，结果一定配套或明确报错，不靠长时间持锁。
 */
export async function reconcileCodexAcp(deps: ReconcileDeps): Promise<InstallResult> {
  const root = deps.root ?? defaultRoot();
  for (let round = 0; round < 3; round++) {
    const v = await deps.codexVersion();
    if (!v) return { ok: false, error: "读不出本机 codex 的版本，没法挑配套的 codex-acp" };
    const got = await prepareFor(v, deps, root);
    if (!got.ok) return got;
    const lock = await pointerLock(root);
    if (!lock) return { ok: false, error: "等 codex-acp 指针锁超时，没切" };
    try {
      if ((await deps.codexVersion()) !== v) continue; // 挑版本期间 Codex 被升过：按新版本重来
      const cur = currentCodexAcp(root);
      if (cur && cur !== "broken" && cur.version === got.version) return got;
      useCodexAcp(got.version, root);
      return got;
    } finally {
      lock.release();
    }
  }
  return { ok: false, error: "对账时 Codex 版本一直在变，没切适配器；等升级结束再跑 acp-install" };
}
