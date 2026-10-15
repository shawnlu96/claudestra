/**
 * 协作视图「待你处理」的唯一口径（UXINBOX1）：顶栏 / 手机按钮 / 大纲按钮 / 右栏「要你定的」/「待你处理」页都用这一份。
 * 开着、等 owner（asks-model.ts waitsOnOwner），且挂在当前视图的项目上；团队键视图再加上它绑定的本机项目的 asks，
 * 以及为这个本机项目开的中心提案授权卡（卡本身挂在大总管上，extra.centerProposal.localProjectId 记着项目）。
 * 团队键解析不出本机项目（绑定没读到 / 已不在）时是「不知道」，界面写「暂无」，不写 0。
 * 待办列表没读到（loaded 为 false），或不完整（full 不为 true）且一条都没有，也是「不知道」（UXCARD3）：「待你处理」页写「读不到」加重试，不写「没有」。
 * 这里不 import react（tests 直接测）；订阅接到 React 的那几行在 collab-view.tsx 的 useOwnerWaits。
 */
import { bindingState, localProjectOf, subscribeBindings } from "@/lib/collab-source-binding";
import { proposalProjectOf, waitsOnOwner, type WebAsk } from "../asks/asks-model";
import type { Tr } from "./collab-model";
import { sharedIdentity } from "./team-source-key";

export interface OwnerWaits { waits: WebAsk[]; unknown: boolean }

/** 提案卡认法定义在 asks-model（收件箱卡头也用），这里照旧转出 */
export { proposalProjectOf };
/** 提案授权卡没有卡号：行上给「去处理」，打开全站收件箱定位到它 */
export const isProposalWait = (a: { extra?: WebAsk["extra"] }): boolean => proposalProjectOf(a) !== null;

/** 待办列表读得怎样（asks-store.ts AsksSnap 的 loaded / full） */
export interface AsksRead { loaded: boolean; full?: boolean }

/**
 * local：undefined = 本机项目视图（只按项目过滤，和以前一样）；null = 团队键解析不出本机项目（不知道）；
 * 字符串 = 团队键绑定的本机项目 id。list：待办列表是否读到 / 完整（不给 = 当作读全了，老调用方不变）。
 */
export function ownerWaits(asks: readonly WebAsk[], project: string, local: string | null | undefined, list?: AsksRead): OwnerWaits {
  if (local === null || (list && !list.loaded)) return { waits: [], unknown: true };
  const here = (a: WebAsk) => a.project === project || (local !== undefined && (a.project === local || proposalProjectOf(a) === local));
  const waits = asks.filter((a) => waitsOnOwner(a) && here(a));
  return { waits, unknown: !!list && list.full !== true && waits.length === 0 };
}

/** 「待你处理」页的局部词表（写法同 work/work-i18n.ts），不改共享字典 */
const EN: Record<string, string> = { "读不到": "Couldn't read", "重试": "Retry", "没有": "None" };
export const waitsText = (tr: Tr, word: string): string => (tr("子 DAG") === "子 DAG" ? word : EN[word] ?? tr(word));

/**
 * 视图的项目 → ownerWaits 的 local。团队键要在 context 里找得到这条绑定才算解析得出：
 * localProjectOf 找不到绑定时按中心项目 id 兜底，那不是本机项目，不能拿来数。
 */
export function viewLocalProject(project: string): string | null | undefined {
  const i = sharedIdentity(project);
  if (!i) return undefined;
  const bound = bindingState(i.machine).identities?.some((c) => c.center === i.center && c.team === i.team && c.project === i.project && c.person === i.person);
  return bound ? localProjectOf(project) : null;
}

/** 团队键视图开着时订这台机器的绑定（没人读过 context 就读一轮），绑定变了叫 cb 重算；本机项目视图什么都不订。返回退订 */
export function subscribeViewBinding(project: string, cb: () => void): () => void {
  const machine = sharedIdentity(project)?.machine;
  return machine ? subscribeBindings(machine, cb) : () => {};
}
