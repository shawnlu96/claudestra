import { ApiError } from "@/lib/api/client";
import { fetchLedger } from "@/lib/api/ledger";
import { cacheOverview, setLedgerAccess } from "../collab-cache";

const probing = new Set<string>();
/** 每个项目最多一条重探链：折叠 / 展开会反复挂载入口，不能每次叠一条定时器 */
const retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>();
const RETRY_MIN_MS = 10_000;
const RETRY_MAX_MS = 60_000;
const lastWait = new Map<string, number>();
/** 每个项目此刻挂着几个入口：全卸载后，在途探测的失败分支不再挂新的重试（审查 #144 第 3 轮 P2-6） */
export const mounted = new Map<string, number>();

/** 读一次总览定入口去留；网络 / bridge 重启这类临时失败按 10s → 60s 退避重探，只在第一次失败时打一行日志 */
export function probe(project: string) {
  if (probing.has(project) || retries.has(project)) return;
  probing.add(project);
  fetchLedger(project)
    .then((ov) => {
      lastWait.delete(project);
      cacheOverview(project, ov, ov.now - Date.now());
    })
    .catch((e) => {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return setLedgerAccess(project, "no");
      if (!mounted.get(project)) return; // 入口已经不在了：不重试，下次挂载再从头探
      const last = lastWait.get(project);
      if (last === undefined) console.warn(`[collab] 探测台账 ${project} 失败，入口先不显示、稍后重试：${(e as Error).message}`);
      const wait = Math.min((last ?? RETRY_MIN_MS / 2) * 2, RETRY_MAX_MS);
      lastWait.set(project, wait);
      retries.set(project, { wait, timer: setTimeout(() => (retries.delete(project), probe(project)), wait) });
    })
    .finally(() => probing.delete(project));
}
/** 入口卸载（项目组折叠 / 侧栏换机器）：取消这个项目挂着的重探，下次挂载再从头探 */
export function cancelRetry(project: string) {
  const r = retries.get(project);
  if (r) clearTimeout(r.timer);
  retries.delete(project);
}
