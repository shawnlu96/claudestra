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
    return null; // 没有 / 坏了：调用方按 currentCodexAcp 的约定区分「没装」和「坏了」
  }
}

/** 同目录唯一的临时名：两个进程（manager 与 bridge）同时装同一版本时不会互相 rename 走对方的文件 */
export const tmpName = (path: string) => `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = tmpName(path);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

interface CurrentAcp { version: string; codexRange: string }
/** null = 从没装过（没指针也没老 2.0.0 目录）；"broken" = 指针或标记坏了 / 缺了，不能信 */
export type AdapterNow = CurrentAcp | null | "broken";

/**
 * 指针指的版本和它的配套范围（只读标记，不验哈希：列表请求每轮都调）。指针文件在但读不出、指向的版本没有合法标记，
 * 都算 "broken" 而不是「没装」：退回 2.0.0 或放行 Codex 升级都会造成错配，调用方要 fail-closed。
 */
export function currentCodexAcp(root = defaultRoot()): AdapterNow {
  const ptr = join(root, POINTER);
  let version = LEGACY.version;
  if (existsSync(ptr)) {
    const v = readJson<{ version?: unknown }>(ptr)?.version;
    if (typeof v !== "string" || !/^\d+\.\d+\.\d+$/.test(v)) return "broken";
    version = v;
  } else if (!existsSync(versionDir(LEGACY.version, root))) {
    return null;
  }
  const m = readJson<Marker>(join(versionDir(version, root), MARKER));
  if (m?.version !== version) return "broken";
  const codexRange = m.codexRange ?? (version === LEGACY.version ? LEGACY.codexRange : undefined);
  return codexRange ? { version, codexRange } : "broken";
}

/**
 * 本机 codex 和当前适配器配套（宿主告警、网页提示、doctor 共用）。没装过适配器 = 没有要配的，不拦（之后 readiness 自动装时
 * 按本机 codex 挑版本）；状态坏了一律算不配套。
 */
export function codexPairsWithAdapter(codexVersion: string | undefined, root?: string): boolean {
  const cur = currentCodexAcp(root);
  return cur === "broken" ? false : !cur || rangeAllows(cur.codexRange, codexVersion);
}

export type Installed = { ok: true; path: string; version: string; codexRange: string } | { ok: false; hint: string };

/**
 * 已装好才算数：指针指的版本标记对、入口文件在，而且入口的 sha256 和安装时记下的一致（装好之后被改过也认得出来，
 * 宿主每次启动都查——1.5MB 算一次哈希不到 10ms）。
 */
export function codexAcpInstalled(root?: string): Installed {
  const cur = currentCodexAcp(root);
  const fix = "跑一次 `bun src/manager.ts acp-install`";
  if (cur === "broken") return { ok: false, hint: `codex-acp 的版本指针或标记坏了：${fix}` };
  const hint = `codex-acp${cur ? ` ${cur.version}` : ""} 没装或装好后被改过：${fix}`;
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

/** 指针文件原文（没有 = null）：切指针时拿它做比较，见 useCodexAcp */
export function readAcpPointer(root = defaultRoot()): string | null {
  try {
    return readFileSync(join(root, POINTER), "utf8");
  } catch {
    return null; // 没有指针（从没切过，或老 2.0.0 安装）：比较时就要求「仍然没有」
  }
}

/**
 * 切指针（宿主下次起适配器就用这个版本）。比较后再切：只有指针仍是调用方开始时读到的 expect 才切，否则说明别的进程
 * （acp-install / 网页更新 / readiness）在这期间切过，拒绝——免得挑版本更早的那一方把指针切回旧版。
 * 比较和写在同一把跨进程锁里；拿不到锁就报错不切（不降级放行）。
 */
export async function useCodexAcp(version: string, expect: string | null, root = defaultRoot()): Promise<void> {
  mkdirSync(root, { recursive: true });
  const lock = await acquireLock(join(root, ".pointer.lock"));
  if (!lock) throw new Error("等 codex-acp 指针锁超时，没切");
  try {
    if (readAcpPointer(root) !== expect) throw new Error("codex-acp 指针在这期间被别的进程切过，没切；重跑一次");
    writeAtomic(join(root, POINTER), JSON.stringify({ version, at: new Date().toISOString() }) + "\n");
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

/** 把一个版本装进它自己的目录，**不切指针**（调用方决定何时切：codex-update 要等 Codex 装成功之后） */
export async function installCodexAcp(rel: AcpRelease, deps: InstallDeps = {}): Promise<InstallResult> {
  if (rel.tarball !== expectedTarball(rel.version)) return { ok: false, error: `tarball 地址不是 ${expectedTarball(rel.version)}，拒装` };
  const dir = versionDir(rel.version, deps.root);
  const dest = entryOf(rel.version, deps.root);
  const ok = { version: rel.version, codexRange: rel.codexRange, path: dest };
  const m = readJson<Marker>(join(dir, MARKER));
  const same = m?.version === rel.version && m.integrity === rel.integrity && m.codexRange === rel.codexRange;
  if (same && existsSync(dest) && sha256Hex(readFileSync(dest)) === m.entrySha256) return { ok: true, reused: true, ...ok };
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
  mkdirSync(dir, { recursive: true });
  writeAtomic(dest, entry);
  const marker = { version: rel.version, integrity: rel.integrity, codexRange: rel.codexRange, entrySha256: sha256Hex(entry), installedAt: new Date().toISOString() };
  writeAtomic(join(dir, MARKER), JSON.stringify(marker) + "\n");
  return { ok: true, reused: false, ...ok };
}

/** 能配 codexVersion 的最新适配器：查 registry、装好、切指针（acp-install 与 readiness 用；codex-update 自己分两步） */
export async function ensureCodexAcpFor(codexVersion: string | undefined, deps: InstallDeps = {}): Promise<InstallResult> {
  if (!codexVersion) return { ok: false, error: "读不出本机 codex 的版本，没法挑配套的 codex-acp" };
  const before = readAcpPointer(deps.root);
  let rel: AcpRelease | null;
  try {
    rel = pickAdapterFor(await fetchAcpReleases(deps.fetchMeta), codexVersion);
  } catch (e) {
    return { ok: false, error: `查 codex-acp 版本失败：${e instanceof Error ? e.message : e}` };
  }
  if (!rel) return { ok: false, error: `npm 上没有能配 codex ${codexVersion} 的 codex-acp 正式版` };
  const r = await installCodexAcp(rel, deps);
  if (!r.ok) return r;
  try {
    await useCodexAcp(r.version, before, deps.root);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return r;
}
