/**
 * team-parity-UXTERM5：团队操作区（审批材料、新建表单、提案页）的文案从词表来，中英文都不含「主场」/ home；
 * 旧的「主场 …」字典键已删（死键 / 被词表句替换），team-ops.tsx 认服务端原因的 r.includes('主场') 原样保留。
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { documentView } from '../web/features/collab/shared/approve/approve-model';
import { approveFixtureMergeView, approveFixtureScopeView } from '../web/features/collab/shared/approve/approve-fixture';
import { featureProposalsTr } from '../web/lib/i18n-dict-feature-proposals';
import { sharedLedgerTr } from '../web/lib/i18n-dict-shared-ledger';
import { sharedExecTr } from '../web/lib/i18n-dict-shared-ledger-v2';
import { BANNED_OWNER_WORDS, MACHINE_WORDS, ownerWordEn } from '../web/lib/owner-words';

const OLD = /主场|\bhome\b/i;
const root = resolve(import.meta.dir, '..');
const src = (f: string) => readFileSync(resolve(root, f), 'utf8');

test('approve-model 三种材料状态（共享副本 / 脱敏摘要 / 无共享材料）的 original 中英文都是词表句，不含主场 / home', () => {
  const states = [documentView(approveFixtureMergeView.document), documentView(approveFixtureScopeView.document), documentView(null)];
  expect(states.map(s => s.kind).sort()).toEqual(['copy', 'none', 'summary']);
  for (const s of states) {
    expect(s.original).toBe(MACHINE_WORDS.originalThere);
    for (const lang of ['zh', 'en'] as const) expect(sharedExecTr(lang)(s.original)).not.toMatch(OLD);
  }
  expect(sharedExecTr('en')(MACHINE_WORDS.originalThere)).toBe('Original text is only visible on the machine running this task');
});

test('新建表单「默认由哪台机器规划」、提案页「项目和任务所在的机器由本机绑定决定」：中英文是新句', () => {
  expect(MACHINE_WORDS.planningMachine).toBe('默认由哪台机器规划');
  expect(MACHINE_WORDS.boundHere).toBe('项目和任务所在的机器由本机绑定决定，不可改');
  for (const [tr, key] of [[sharedLedgerTr, MACHINE_WORDS.planningMachine], [featureProposalsTr, MACHINE_WORDS.boundHere]] as const) {
    expect(tr('zh')(key)).toBe(key);
    expect(tr('en')(key)).toBe(ownerWordEn(key)!);
    for (const lang of ['zh', 'en'] as const) {
      expect(tr(lang)(key)).not.toMatch(OLD);
      expect(BANNED_OWNER_WORDS.filter(w => tr(lang)(key).includes(w))).toEqual([]);
    }
  }
  expect(src('web/features/collab/shared/shared-forms.tsx')).toContain('{tr(MACHINE_WORDS.planningMachine)}');
  expect(src('web/features/collab/feature-proposals/proposals-view.tsx')).toContain('{tr(MACHINE_WORDS.boundHere)}');
});

test('旧「主场」字典键已删：英文下原样返回中文键，不再给 Home / home', () => {
  const gone = ['主场', '默认规划主场', '全文仅在主场', 'V1 仅共享规划，执行操作仍在主场', '主场在线状态未知', '主场镜像过期', '主场镜像最新',
    '来源镜像只读', '尚无执行镜像'];
  for (const key of gone) expect(sharedLedgerTr('en')(key)).toBe(key);
  for (const key of ['主场', '仅在主场']) expect(sharedExecTr('en')(key)).toBe(key);
  expect(featureProposalsTr('en')('项目、主场由本机绑定决定，不可改')).toBe('项目、主场由本机绑定决定，不可改');
  for (const f of ['web/lib/i18n-dict-shared-ledger.ts', 'web/lib/i18n-dict-shared-ledger-v2.ts', 'web/lib/i18n-dict-feature-proposals.ts',
    'web/features/collab/team-body/team-body-i18n.ts']) expect({ f, hit: src(f).match(/主场|镜像|\bhome\b|\bV1\b/i)?.[0] ?? null }).toEqual({ f, hit: null });
});

test('团队操作区组件里不再有「主场」字面量；team-ops.tsx 认服务端原因的判断原样保留', () => {
  for (const f of ['shared/approve/approve-panel.tsx', 'shared/approve/approve-model.ts', 'shared/task/task-forms.tsx', 'shared/exec/exec-panel.tsx',
    'shared/shared-forms.tsx', 'feature-proposals/proposals-view.tsx']) {
    expect({ f, hit: src(`web/features/collab/${f}`).includes('主场') }).toEqual({ f, hit: false });
  }
  expect(src('web/features/collab/shared/team-ops.tsx')).toContain("r.includes('主场') ? collabTr(MACHINE_WORDS.planOnly) : r");
});
