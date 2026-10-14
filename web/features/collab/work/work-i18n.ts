/** Translate board labels locally so short step words do not change other collaboration views. */
import { READY_WORD, STAGE_WORD, ownerWordEn } from '@/lib/owner-words';
import type { Tr } from '../collab-model';
const WORDS: Record<string, string> = {
  '规格': 'Specification', '老卡': 'Legacy cards', '执行者不在了': 'Worker is no longer available',
  'spec': 'Specification', 'restate': 'Restating', 'build': 'Writing', 'fix': 'Fixing', 'review': 'Reviewing',
  'merge': 'Merging', 'blocked': 'Blocked',
  '谁在干活': 'Who is working', '在干活': 'Working', '在等': 'Waiting', '待做': 'To do', [READY_WORD]: ownerWordEn(READY_WORD)!, [STAGE_WORD.blocked]: ownerWordEn(STAGE_WORD.blocked)!,
  '本机': 'Local', '全部做完预计': 'Estimated completion', '暂无': 'None', '名额不可用': 'No available slots',
  '按近 7 天每步中位数 + 关键路径': 'Based on 7-day step medians + critical path',
  '合并': 'Merging', '部署': 'Deploying', '上线': 'Live', '交付中': 'Publishing',
  '等审查员领单': 'Waiting for a reviewer to claim', '等执行者领单': 'Waiting for a worker to claim', '等 CI': 'Waiting for CI',
  '等 owner': 'Waiting for owner', '本机名额满': 'Local slots full', '外部结果不明': 'External result unknown', '缺规格': 'Missing specification',
  '等 PM 解除阻塞': 'Waiting for PM to unblock',
  '在等合并': 'Awaiting merge', '等合并': 'Awaiting merge', '正在合并': 'Merging now', '其他成员的机器': "Another member's machine",
  '已上线 · 等验证': 'Live · awaiting verification', '等 PM 放行': 'Waiting for PM approval',
};
export function workText(tr: Tr, text: string): string {
  if (tr('子 DAG') === '子 DAG') return text;
  if (ownerWordEn(text) ?? WORDS[text]) return ownerWordEn(text) ?? WORDS[text];
  return text.replace(/合并排队：前面是 /g, 'Merge queue: behind ').replace(/被 (.+) 挡住/g, 'Blocked by $1')
    .replace(/等 PM答复：/g, 'Waiting for PM response: ').replace(/等执行者答复：/g, 'Waiting for worker response: ')
    .replace(/等 PM：/g, 'Waiting for PM: ').replace(/退回人工/g, 'Manual intervention').replace(/额度到线暂停：/g, 'Paused at quota limit: ')
    .replace(/文件锁：/g, 'File lock: ').replace(/等待前置任务：/g, 'Waiting for dependencies: ');
}
