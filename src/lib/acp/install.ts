/**
 * codex-acp 适配器的安装（`manager acp-install`、readiness 的自动安装、网页「更新并重启」）。GitHub release 上没有附件，
 * 所以直接下 npm registry 上的包文件，只解出 dist/index.js（esbuild 打好的单文件）放进状态目录的 codex-acp-<版本>/，
 * 用我们自己的 bun 跑；设了 CODEX_PATH 时它不加载 @openai/codex，所以不进 package.json、不装依赖。
 * - 信任链：版本和 sha512 都取自 registry 元数据（resolve.ts），下载后按 dist.integrity 验包，对不上就拒装。信任 registry
 *   是因为 Codex 本身就是 `npm install -g @openai/codex` 从同一个 registry 装的——registry 若被攻破，Codex 早已失守，
 *   写死 sha 只会让每个 Codex 小版本都要改代码发版。改成写死会让「自动跟随」失效；改成别的源要另起信任理由。
 * - 当前用哪个版本：状态目录 acp/current.json 指针（tmp+rename 原子切换），旧版本目录都留着，指针指回去即回退。
 * - 没有指针但有 2.0.0 的老安装（这套机制之前的唯一版本）照样认，配套范围按它的 package.json 记 ^0.158.0。
 * tests/acp-install.test.ts。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { statePath } from "../paths.js";
import { fetchAcpReleases, pickAdapterFor, rangeAllows, type AcpRelease, type MetaFetch } from "./resolve.js";

const LEGACY = { version: "2.0.0", codexRange: "^0.158.0" };
const ENTRY_IN_TAR = "package/dist/index.js";
/** 包文件 2.0.x 约 270KB；超过这个数一定不是我们要的那个，不读完 */
const MAX_TARBALL_BYTES = 8 * 1024 * 1024;
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
    return null; // 没有 / 坏了：调用方都按「没装」处理并给安装提示
  }
}

export interface CurrentAcp { version: string; codexRange: string }

/** 指针指的版本和它的配套范围（只读标记，不验哈希：列表请求每轮都调）；没装返回 null */
export function currentCodexAcp(root?: string): CurrentAcp | null {
  const version = readJson<{ version?: string }>(join(root ?? defaultRoot(), POINTER))?.version ?? LEGACY.version;
  const m = readJson<Marker>(join(versionDir(version, root), MARKER));
  if (m?.version !== version) return null;
  const codexRange = m.codexRange ?? (version === LEGACY.version ? LEGACY.codexRange : undefined);
  return codexRange ? { version, codexRange } : null;
}

/**
 * 本机 codex 和当前适配器配套（宿主告警、网页提示、codex-update 端点、doctor 共用）。没装适配器 = 没有要配的，不拦：
 * 之后 readiness 自动装时会按本机 codex 挑版本。
 */
export function codexPairsWithAdapter(codexVersion: string | undefined, root?: string): boolean {
  const cur = currentCodexAcp(root);
  return !cur || rangeAllows(cur.codexRange, codexVersion);
}

export type Installed = { ok: true; path: string; version: string; codexRange: string } | { ok: false; hint: string };

/**
 * 已装好才算数：指针指的版本标记对、入口文件在，而且入口的 sha256 和安装时记下的一致（装好之后被改过也认得出来，
 * 宿主每次启动都查——1.5MB 算一次哈希不到 10ms）。
 */
export function codexAcpInstalled(root?: string): Installed {
  const cur = currentCodexAcp(root);
  const hint = `codex-acp${cur ? ` ${cur.version}` : ""} 没装或装好后被改过：跑一次 \`bun src/manager.ts acp-install\``;
  if (!cur) return { ok: false, hint };
  const entry = entryOf(cur.version, root);
  const m = readJson<Marker>(join(versionDir(cur.version, root), MARKER));
  try {
    if (m?.entrySha256 && existsSync(entry) && sha256Hex(readFileSync(entry)) === m.entrySha256) return { ok: true, path: entry, ...cur };
  } catch (e) {
    console.warn(`⚠️ [acp-install] 读 ${entry} 失败，按没装处理:`, e);
  }
  return { ok: false, hint };
}

/** 原子切换指针：宿主下次起适配器（重启 / 退避重起）就用这个版本 */
export function useCodexAcp(version: string, root = defaultRoot()): void {
  const p = join(root, POINTER);
  mkdirSync(root, { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify({ version, at: new Date().toISOString() }) + "\n");
  renameSync(`${p}.tmp`, p);
}

export type InstallResult = { ok: true; path: string; reused: boolean; version: string; codexRange: string } | { ok: false; error: string };
type TarballFetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
export interface InstallDeps {
  fetch?: TarballFetch;
  fetchMeta?: MetaFetch;
  root?: string;
}
const defaultFetch: TarballFetch = (u) => fetch(u, { signal: AbortSignal.timeout(60_000) });

/** 把一个版本装进它自己的目录，**不切指针**（调用方决定何时切：codex-update 要等 Codex 装成功之后） */
export async function installCodexAcp(rel: AcpRelease, deps: InstallDeps = {}): Promise<InstallResult> {
  const dir = versionDir(rel.version, deps.root);
  const dest = entryOf(rel.version, deps.root);
  const ok = { version: rel.version, codexRange: rel.codexRange, path: dest };
  const m = readJson<Marker>(join(dir, MARKER));
  if (m?.version === rel.version && m.integrity === rel.integrity && existsSync(dest) && sha256Hex(readFileSync(dest)) === m.entrySha256) {
    return { ok: true, reused: true, ...ok };
  }
  let tgz: Uint8Array;
  try {
    const res = await (deps.fetch ?? defaultFetch)(rel.tarball);
    if (!res.ok) return { ok: false, error: `下载 ${rel.tarball} 失败：HTTP ${res.status}` };
    tgz = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `下载 ${rel.tarball} 失败：${e instanceof Error ? e.message : e}` };
  }
  if (tgz.length > MAX_TARBALL_BYTES) return { ok: false, error: `包文件 ${tgz.length} 字节，远超预期，拒装` };
  const got = sha512Integrity(tgz);
  if (got !== rel.integrity) return { ok: false, error: `integrity 与 registry 公布的对不上，拒装（期望 ${rel.integrity}，实际 ${got}）` };
  let entry: Uint8Array | null;
  try {
    entry = extractTarEntry(gunzipSync(tgz), ENTRY_IN_TAR);
  } catch (e) {
    return { ok: false, error: `解包失败：${e instanceof Error ? e.message : e}` };
  }
  if (!entry) return { ok: false, error: `包里没有 ${ENTRY_IN_TAR}` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dest}.tmp`, entry);
  renameSync(`${dest}.tmp`, dest);
  const marker = { version: rel.version, integrity: rel.integrity, codexRange: rel.codexRange, entrySha256: sha256Hex(entry), installedAt: new Date().toISOString() };
  writeFileSync(join(dir, MARKER), JSON.stringify(marker) + "\n");
  return { ok: true, reused: false, ...ok };
}

/** 能配 codexVersion 的最新适配器：查 registry、装好、切指针（acp-install 与 readiness 用；codex-update 自己分两步） */
export async function ensureCodexAcpFor(codexVersion: string | undefined, deps: InstallDeps = {}): Promise<InstallResult> {
  if (!codexVersion) return { ok: false, error: "读不出本机 codex 的版本，没法挑配套的 codex-acp" };
  let rel: AcpRelease | null;
  try {
    rel = pickAdapterFor(await fetchAcpReleases(deps.fetchMeta), codexVersion);
  } catch (e) {
    return { ok: false, error: `查 codex-acp 版本失败：${e instanceof Error ? e.message : e}` };
  }
  if (!rel) return { ok: false, error: `npm 上没有能配 codex ${codexVersion} 的 codex-acp 正式版` };
  const r = await installCodexAcp(rel, deps);
  if (r.ok) useCodexAcp(r.version, deps.root);
  return r;
}
