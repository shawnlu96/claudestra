/**
 * 项目地图这一批（PDLAYOUT1 / PDCARD1 / PDEDGEUI1 / PDVIEW1）的局部词表：一次放齐，并行的卡不用再改这个文件。
 * 写法同 count-words-i18n.ts：中文原样，英文查本表，查不到退回 tr。不进共享字典（collab-i18n.ts / i18n-dict-collab.ts 归 UXTERM2）。
 * 「在等前置」不简写成「在等」：「在等」是看板上等审查、等合并的活（count-words.ts），同一张卡上不能有两种意思。
 */
import { fillParams, type I18nParams } from '@/lib/i18n-fill';
import { READY_WORD } from '@/lib/owner-words';
import type { Tr } from '../collab-model';

const WORDS: Record<string, string> = {
  // PDLAYOUT1
  '按依赖': 'By dependency', '按板块': 'By area', '依赖链 · {n} 串': 'Chains · {n}', '独立推进 · {n} 个': 'Standalone · {n}',
  '{n} 在跑': '{n} running', '已收尾': 'Wrapped up', '已暂停': 'Paused', '冻结': 'Frozen', '未分组': 'Ungrouped', '拆自 {x}': 'Split from {x}',
  '还没配置板块分组': 'Area grouping is not configured yet', '{n} 个没收尾': '{n} open', '在跑': 'running', '受阻': 'blocked',
  '久未动': 'idle too long', [READY_WORD]: 'ready to start', '待验收': 'awaiting sign-off', '在等前置': 'waiting on prerequisites',
  '已收尾 {n}': 'Wrapped up {n}', '已暂停 {n}': 'Paused {n}', '布局': 'Layout',
  // PDCARD1
  '{n} 受阻': '{n} blocked', '{n} 天没动': 'idle {n} d', '{n} 小时没动': 'idle {n} h', '读不到': 'Unavailable', '第 {n} 轮': 'round {n}',
  '还有 {n} 个节点': '{n} more nodes', '{n} 分': '{n} min', '{n} 小时': '{n} h', '{n} 天': '{n} d', '全部完成，还没关单': 'All done, not closed yet',
  // PDEDGEUI1
  '已成立': 'Satisfied', '在等': 'Waiting', '等文件锁': 'Waiting on file lock', '手写依赖': 'Declared dependency',
  '{n} 条任务依赖': '{n} task dependencies', '手写 + {n} 条任务依赖': 'Declared + {n} task dependencies', '{n} 处等文件锁': '{n} file-lock waits',
  '另有 {n} 处': '{n} more', '{k} 想改 {path}': '{k} wants {path}', '被 {task} 的 {path} 占着': 'held by {task} ({path})', '{t} 起': 'since {t}',
  '关闭': 'Close',
  // PDVIEW1
  '还有 {n} 个独立推进': '{n} more standalone',
};

/** 中文界面原样（带参数填好）；其他语言查本表，查不到退回调用方的 tr */
export function pdText(tr: Tr, word: string, params?: I18nParams): string {
  if (tr('子 DAG') === '子 DAG') return fillParams(word, params);
  const en = WORDS[word];
  return en ? fillParams(en, params) : tr(word, params);
}
