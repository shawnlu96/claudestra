import { useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api/client";
import { fetchLedger } from "@/lib/api/ledger";
import { cacheOverview, setLedgerAccess } from "../collab-cache";

const probing = new Set<string>();
/** 每个项目最多一条重探链：折叠 / 展开会反复挂载入口，不能每次叠一条定时器 */
const retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>();
const RETRY_MIN_MS = 10_000;
const RETRY_MAX_MS = 60_000;
const lastWait = new Map<string, number>();
/** 上次探测是临时失败、正等重探的项目：入口据此出灰行 + 重试按钮，而不是什么都不显示 */
const failed = new Set<string>();
const subs = new Set<() => void>();
/** 每个项目此刻挂着几个入口：全卸载后，在途探测的失败分支不再挂新的重试（审查 #144 第 3 轮 P2-6） */
export const mounted = new Map<string, number>();

const notify = () => { for (const cb of subs) cb(); };
function mark(set: Set<string>, project: string, on: boolean) {
  if (set.has(project) === on) return;
  if (on) set.add(project);
  else set.delete(project);
  notify();
}

/** 读一次总览定入口去留；网络 / bridge 重启这类临时失败按 10s → 60s 退避重探，只在第一次失败时打一行日志 */
export function probe(project: string) {
  if (probing.has(project) || retries.has(project)) return;
  mark(probing, project, true);
  fetchLedger(project)
    .then((ov) => {
      lastWait.delete(project);
      mark(failed, project, false);
      cacheOverview(project, ov, ov.now - Date.now());
    })
    .catch((e) => {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        mark(failed, project, false);
        return setLedgerAccess(project, "no");
      }
      if (!mounted.get(project)) return; // 入口已经不在了：不重试，下次挂载再从头探
      const last = lastWait.get(project);
      if (last === undefined) console.warn(`[collab] 探测台账 ${project} 失败，入口先变灰、稍后重试：${(e as Error).message}`);
      const wait = Math.min((last ?? RETRY_MIN_MS / 2) * 2, RETRY_MAX_MS);
      lastWait.set(project, wait);
      retries.set(project, { wait, timer: setTimeout(() => (retries.delete(project), probe(project)), wait) });
      mark(failed, project, true);
    })
    .finally(() => mark(probing, project, false));
}

/** 用户点重试：撤掉挂着的那条重探立刻再探。在途时什么都不做（probe 自己挡），失败后照旧接着同一条退避链 */
export function retryNow(project: string) {
  const r = retries.get(project);
  if (r) clearTimeout(r.timer);
  retries.delete(project);
  probe(project);
}

/** 入口卸载（项目组折叠 / 侧栏换机器）：取消这个项目挂着的重探、清掉失败态，下次挂载再从头探 */
export function cancelRetry(project: string) {
  const r = retries.get(project);
  if (r) clearTimeout(r.timer);
  retries.delete(project);
  mark(failed, project, false);
}

function useFlag(set: Set<string>, project: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => set.has(project),
    () => false,
  );
}
/** 上次探测临时失败、正在等重探（非 hook 读法，单测用；组件用 useProbeFailed） */
export const probeFailed = (project: string) => failed.has(project);
export const useProbeFailed = (project: string) => useFlag(failed, project);
/** 这个项目有一个探测在途（重试按钮转圈用） */
export const useProbing = (project: string) => useFlag(probing, project);
