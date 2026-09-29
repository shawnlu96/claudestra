/**
 * codex-acp 适配器的安装（`manager acp-install`，T60）。GitHub release 上没有任何附件，所以直接下载 npm registry 上的
 * 包文件：版本钉死、sha256 写死在这里，校验不过就拒装、报错，**不回退到 npm**（Shawn 定的）。包里 dist/index.js 是
 * esbuild 打好的单文件，只把它解出来放到状态目录，用我们自己的 bun 跑；设了 CODEX_PATH 时它不会去加载那份 344MB 的
 * @openai/codex，所以不进 package.json、也不装依赖。升级适配器 = 改这里的版本和 sha256（launcher 在 acp 模式下暂停
 * Codex 自动升级，两边一起手动对齐，见 docs/runtimes/codex-acp.md）。tests/acp-install.test.ts。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { statePath } from "../paths.js";

export const CODEX_ACP_VERSION = "2.0.0";
/** registry.npmjs.org 上 codex-acp-2.0.0.tgz 的 sha256（它的 sha512 与 registry 公布的 integrity 对得上） */
export const CODEX_ACP_SHA256 = "a8d48bdf70c0e3e585abbdce19f78765450d8fa6ada1da0fd53508e64315905b";
const TARBALL_URL = `https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-${CODEX_ACP_VERSION}.tgz`;
const ENTRY_IN_TAR = "package/dist/index.js";
/** 包文件 269KB；超过这个数一定不是我们要的那个，不读完 */
const MAX_TARBALL_BYTES = 8 * 1024 * 1024;

const codexAcpDir = (root = statePath("acp")) => join(root, `codex-acp-${CODEX_ACP_VERSION}`);
export const codexAcpEntry = (root?: string) => join(codexAcpDir(root), "index.js");
const MARKER = "installed.json";

export const sha256Hex = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");

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

export type InstallResult = { ok: true; path: string; reused: boolean } | { ok: false; error: string };

export interface InstallDeps {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  root?: string;
  /** 只给单测换成自造包文件的 sha256；生产路径永远是上面写死的那个（不从环境变量 / 命令行读） */
  expectSha256?: string;
}

/**
 * 已装好才算数：标记里的版本对、入口文件在，而且入口文件的 sha256 和安装时记下的一致（装好之后被改过也认得出来，
 * 宿主每次启动都查——1.5MB 算一次哈希不到 10ms）。
 */
export function codexAcpInstalled(root?: string, tarSha = CODEX_ACP_SHA256): { ok: true; path: string } | { ok: false; hint: string } {
  const entry = codexAcpEntry(root);
  try {
    const m = JSON.parse(readFileSync(join(codexAcpDir(root), MARKER), "utf8"));
    if (m?.version === CODEX_ACP_VERSION && m?.sha256 === tarSha && existsSync(entry) && sha256Hex(readFileSync(entry)) === m.entrySha256) return { ok: true, path: entry };
  } catch {
    /* 没装过 / 标记坏了：按没装处理，下面给安装提示 */
  }
  return { ok: false, hint: `codex-acp ${CODEX_ACP_VERSION} 没装或装好后被改过：跑一次 \`bun src/manager.ts acp-install\`` };
}

export async function installCodexAcp(deps: InstallDeps = { fetch: (u) => fetch(u, { signal: AbortSignal.timeout(60_000) }) }): Promise<InstallResult> {
  const expect = deps.expectSha256 ?? CODEX_ACP_SHA256;
  const have = codexAcpInstalled(deps.root, expect);
  if (have.ok) return { ok: true, path: have.path, reused: true };
  let tgz: Uint8Array;
  try {
    const res = await deps.fetch(TARBALL_URL);
    if (!res.ok) return { ok: false, error: `下载 ${TARBALL_URL} 失败：HTTP ${res.status}` };
    tgz = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `下载 ${TARBALL_URL} 失败：${e instanceof Error ? e.message : e}` };
  }
  if (tgz.length > MAX_TARBALL_BYTES) return { ok: false, error: `包文件 ${tgz.length} 字节，远超预期，拒装` };
  const got = sha256Hex(tgz);
  if (got !== expect) return { ok: false, error: `sha256 对不上，拒装（期望 ${expect}，实际 ${got}）` };
  let entry: Uint8Array | null;
  try {
    entry = extractTarEntry(gunzipSync(tgz), ENTRY_IN_TAR);
  } catch (e) {
    return { ok: false, error: `解包失败：${e instanceof Error ? e.message : e}` };
  }
  if (!entry) return { ok: false, error: `包里没有 ${ENTRY_IN_TAR}` };
  const dir = codexAcpDir(deps.root);
  mkdirSync(dir, { recursive: true });
  const dest = codexAcpEntry(deps.root);
  writeFileSync(`${dest}.tmp`, entry);
  renameSync(`${dest}.tmp`, dest);
  const marker = { version: CODEX_ACP_VERSION, sha256: expect, entrySha256: sha256Hex(entry), installedAt: new Date().toISOString() };
  writeFileSync(join(dir, MARKER), JSON.stringify(marker) + "\n");
  return { ok: true, path: dest, reused: false };
}
