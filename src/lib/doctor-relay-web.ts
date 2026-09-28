/**
 * doctor 的「中继托管的网页」一项：中继（RELAY_STATIC_DIR）托管的是它自己的一份前端，只随
 * `RELAY_WITH_WEB=1 deploy/relay/deploy.sh` 更新；本机 `web-release` / `update` 只换 bridge 托管的那份。
 * 手机原生壳和配对链接都从中继打开，中继那份落后 = 本机发布的网页改动在手机上根本不生效，而前端的
 * 「有新版本」提示问的也是中继，看不出来。判定是纯函数 relayWebCheck（tests/doctor-relay-web.test.ts）。
 */
import type { Check } from "./doctor.js";
import { fetchRelayStatus } from "./doctor-relay.js";

export interface RelayWebFacts {
  /** 中继 /build-info.json 的 webCommit；拿不到（中继没托管前端 / 网络不通）为 null */
  relay: string | null;
  /** 本机 bridge 托管的那份（BRIDGE_STATIC_DIR/build-info.json） */
  local: string | null;
  /** relay 是 local 的祖先（= 中继那份更旧）；本机 git 认不出 relay 的 commit 时为 null */
  relayOlder: boolean | null;
}

const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

export function relayWebCheck(f: RelayWebFacts, base: string, group: string): Check | null {
  if (!f.relay || !f.local) return null; // 中继没托管前端 / 本机没托管：没有可比的，不出这一项
  const name = "中继托管的网页";
  if (sameCommit(f.relay, f.local)) return { group, name, status: "ok", detail: `与本机一致（${f.local}）` };
  if (f.relayOlder) {
    return { group, name, status: "warn",
      detail: `https://${base} 托管的是 ${f.relay}，本机已发布 ${f.local} —— 经中继打开的手机（原生壳 / 配对链接）拿到的是旧网页，之后的网页改动都没生效`,
      fix: "在主仓库跑 RELAY_WITH_WEB=1 deploy/relay/deploy.sh <user@中继主机>（docs/relay/self-host.md）" };
  }
  return { group, name, status: "ok", detail: `中继 ${f.relay}、本机 ${f.local}：不是本机历史里更旧的版本（中继可能由别的实例部署）` };
}

/** 中继首页同源的 /build-info.json（web/scripts/gen-build-info.mjs 生成，随静态导出上线） */
export async function fetchRelayWebCommit(base: string): Promise<string | null> {
  try {
    const r = await fetch(`https://${base}/build-info.json`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const o = (await r.json()) as { webCommit?: unknown };
    return typeof o.webCommit === "string" && /^[0-9a-f]{4,40}$/.test(o.webCommit) ? o.webCommit : null;
  } catch {
    return null; // 中继不通由「中继」一项报（relayChecks），这里再报一遍只是噪音
  }
}

/** a 是否是 b 的祖先（且不同）；本机仓库里没有 a（别的实例部署的）→ null */
async function isOlderCommit(repoRoot: string, a: string, b: string): Promise<boolean | null> {
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["git", "-C", repoRoot, ...args], { stdout: "ignore", stderr: "ignore" });
    return await p.exited;
  };
  if ((await run("cat-file", "-e", `${a}^{commit}`)) !== 0) return null;
  return (await run("merge-base", "--is-ancestor", a, b)) === 0;
}

export async function collectRelayWeb(repoRoot: string, base: string, localStaticDir: string, readLocal: (dir: string) => string | null): Promise<RelayWebFacts> {
  const [relay, local] = [await fetchRelayWebCommit(base), readLocal(localStaticDir)];
  const relayOlder = relay && local && !sameCommit(relay, local) ? await isOlderCommit(repoRoot, relay, local) : null;
  return { relay, local, relayOlder };
}

/**
 * web-release 发完之后的一句提醒：本机那份换了、中继那份还旧 → 返回要说给人听的话。
 * 拿不到中继状态 / 中继没托管前端 / 已经一致 → null。
 */
export async function relayWebReminder(repoRoot: string, localStaticDir: string, readLocal: (dir: string) => string | null): Promise<string | null> {
  const st = await fetchRelayStatus();
  if (!st?.connected || !st.base) return null;
  const c = relayWebCheck(await collectRelayWeb(repoRoot, st.base, localStaticDir, readLocal), st.base, "");
  return c?.status === "warn" ? `${c.detail}；${c.fix}` : null;
}
