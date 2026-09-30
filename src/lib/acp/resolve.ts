/**
 * 哪个 codex-acp 配得上本机的 Codex：读 npm registry 上这个包的元数据，看每个版本 dependencies 里的 @openai/codex 范围。
 * 只从这份元数据取三样：配套范围、dist.integrity（sha512，安装时验包用）、tarball 地址（只认 registry.npmjs.org）。
 * 信任 registry 的理由见 install.ts 顶部。tests/acp-resolve.test.ts。
 */
const CODEX_ACP_META_URL = "https://registry.npmjs.org/@agentclientprotocol/codex-acp";
/** 元数据里的 tarball 不在这个前缀下一律不认：元数据被篡改也只能指回 registry 自己 */
const TARBALL_PREFIX = `${CODEX_ACP_META_URL}/-/`;
/**
 * 宿主（host.ts / session.ts）只在 2.0.0 及以后验证过：更早的适配器对 AIR / steering 的实现不同，
 * 本机 codex 旧到只有 1.x 能配时宁可解析不到，也不装一个宿主没跑过的协议版本。
 */
const MIN_ADAPTER = "2.0.0";

export interface AcpRelease {
  version: string;
  /** dependencies["@openai/codex"] 原文，如 ^0.159.1 */
  codexRange: string;
  /** sha512-<base64> */
  integrity: string;
  tarball: string;
}

const STABLE = /^\d+\.\d+\.\d+$/;
/**
 * 只认 ^x.y.z / ~x.y.z / x.y.z（codex-acp 历来都是 ^）：Bun.semver 把认不出的范围、`*`、`>=0` 都当成全匹配，
 * 放宽写法就等于元数据里一个宽范围能让任意 codex 都「配套」。
 */
const SIMPLE_RANGE = /^[\^~]?\d+\.\d+\.\d+$/;

/** 元数据 → 可用的正式版列表（旧到新）；字段缺失、预发布、tarball 不在 registry 上的都丢掉 */
export function parseAcpReleases(meta: unknown): AcpRelease[] {
  const versions = (meta as { versions?: Record<string, any> } | null)?.versions;
  if (!versions || typeof versions !== "object") return [];
  const out: AcpRelease[] = [];
  for (const [version, v] of Object.entries(versions)) {
    const codexRange = v?.dependencies?.["@openai/codex"];
    const integrity = v?.dist?.integrity;
    const tarball = v?.dist?.tarball;
    if (!STABLE.test(version) || Bun.semver.order(version, MIN_ADAPTER) < 0) continue;
    if (typeof codexRange !== "string" || typeof integrity !== "string" || !integrity.startsWith("sha512-")) continue;
    if (typeof tarball !== "string" || !tarball.startsWith(TARBALL_PREFIX)) continue;
    out.push({ version, codexRange, integrity, tarball });
  }
  return out.sort((a, b) => Bun.semver.order(a.version, b.version));
}

/** codex 版本落在范围里（范围不是上面那三种写法就算不配套：宁可不给按钮也不装错） */
export function rangeAllows(range: string | undefined, codexVersion: string | undefined): boolean {
  if (!range || !SIMPLE_RANGE.test(range) || !codexVersion || !STABLE.test(codexVersion)) return false;
  return Bun.semver.satisfies(codexVersion, range);
}

/** 能配 codexVersion 的最高正式版；一个都没有返回 null */
export function pickAdapterFor(releases: AcpRelease[], codexVersion: string | undefined): AcpRelease | null {
  for (let i = releases.length - 1; i >= 0; i--) if (rangeAllows(releases[i]!.codexRange, codexVersion)) return releases[i]!;
  return null;
}

export type MetaFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
const defaultMetaFetch: MetaFetch = (u) => fetch(u, { signal: AbortSignal.timeout(10_000) });

export async function fetchAcpReleases(f: MetaFetch = defaultMetaFetch): Promise<AcpRelease[]> {
  const r = await f(CODEX_ACP_META_URL);
  if (!r.ok) throw new Error(`读 ${CODEX_ACP_META_URL} 失败：HTTP ${r.status}`);
  return parseAcpReleases(await r.json());
}
