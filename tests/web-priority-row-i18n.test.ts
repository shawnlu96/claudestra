import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { prioritySnapshot } from './web-priority-row-owner-words.test';
import { priorityHistoryText } from '../web/lib/owner-words';
import { testChildEnv } from './test-env';

function renderCheck(check: string) {
  const script = `
    import { GlobalRegistrator } from '@happy-dom/global-registrator';
    import { mock } from 'bun:test';
    import { strict as assert } from 'node:assert';
    GlobalRegistrator.register({ url: 'http://localhost/' });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { createElement: h, act } = await import('./node_modules/react');
    const { createRoot } = await import('./node_modules/react-dom/client');
    const { setLang } = await import('./lib/i18n');
    let failure = null;
    mock.module('./lib/api/priority', () => ({
      requestPriority: async () => { if (failure) throw failure; return { askId: 'ask-1', label: '本会应用：改为现在做', choice: 'priority_apply' }; },
      fetchPriorityHistory: async () => ({ history: [{ seq: 1, ts: data.now, actor: 'owner', text: '本会应用：改为现在做', data: {} }] }), priorityResult: async () => ({ verified: true, observed: true }),
    }));
    const { ApiError } = await import('./lib/api/client');
    const { PriorityPanel } = await import('./features/collab/priority/priority-panel');
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const data = ${JSON.stringify(prioritySnapshot)};
    const props = { project: 'proj-map', now: data.now, data, error: '', stale: false, reload: async () => {}, onTask() {}, onNode() {} };
    const render = async () => act(async () => { root.render(h(PriorityPanel, props)); });
    const click = async (text) => act(async () => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent === text);
      assert.ok(button, 'missing button: ' + text); button.click();
    });
    const panelText = () => { const p = document.querySelector('[data-priority-panel]'); return p.textContent +
      [...p.querySelectorAll('[title], [aria-label]')].map(e => e.getAttribute('title') + e.getAttribute('aria-label')).join(' '); };
    ${check}
    await act(async () => root.unmount());
    GlobalRegistrator.unregister();
  `;
  const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
    cwd: resolve(import.meta.dir, '../web'), env: testChildEnv(), stdout: 'pipe', stderr: 'pipe',
  });
  expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual({ code: 0, stderr: '' });
}

test('UXTERM6 regression: English reasons retain dependency references and translate system explanations', () => renderCheck(`
  setLang('en');
  for (const [state, reason, english] of [
    ['dependency', '等待依赖：A、B', 'Waiting for dependencies: A, B'],
    ['uncertain', '外部结果不明，需核实', 'External result uncertain; verification required'],
    ['unknown', '数据未知：尚无可靠的执行或等待状态', 'No reliable execution or waiting state yet'],
    ['unknown', '未绑卡计划：开工及停滞数据未知', 'Planned node without a card: start and stall data unknown'],
    ['capacity', '本机名额满', 'Local capacity is full'],
    ['waiting', '尚未收录的系统原因', 'Waiting'],
  ]) {
    Object.assign(data.rows[0], { state, reason }); await render();
    assert.ok(panelText().includes(english), panelText());
    assert.doesNotMatch(panelText(), /[\\u4e00-\\u9fff]/);
  }
`));

test('UXTERM6 regression: source tooltip retains owner note and inherited module identity', () => renderCheck(`
  data.rows[0].priority.note = 'owner note';
  data.rows[1].feature = null;
  await render();
  const rows = document.querySelectorAll('article');
  assert.ok(rows[0].textContent.includes('owner 显式登记'));
  assert.ok([...rows[0].querySelectorAll('[title]')].some(e => e.title.includes('owner note')));
  assert.ok([...rows[1].querySelectorAll('[title]')].some(e => e.title.includes('module-export')));
  assert.ok(![...rows[1].querySelectorAll('[title]')].some(e => e.title.includes('不属于任何模块')));
  data.rows[1].priority.inheritedFrom = null; data.rows[1].featureId = null;
  await render();
  assert.ok([...document.querySelectorAll('article')[1].querySelectorAll('[title]')].some(e => e.title.includes('所属模块名称未知')));
`));

test('UXTERM6 regression: confirmation labels follow operation, mode and live language; errors are localized', () => renderCheck(`
  setLang('en'); await render();
  for (const [button, expected] of [
    ['Do now', 'Change to Do now'], ['Do next', 'Change to Do next'], ['Can wait', 'Change to Can wait'],
    ['Restore inheritance', 'Restore inheritance'], ['Move down', 'Move down within band'],
  ]) {
    await click('Adjust'); await click('Record for this session: ' + button);
    assert.equal(document.querySelector('[aria-label="Confirm priority request"] strong').textContent, 'Record for this session: ' + expected);
    assert.doesNotMatch(panelText(), /[\\u4e00-\\u9fff]/);
    await click('Collapse');
  }
  await click('Adjust'); await click('Record for this session: Do now');
  await act(async () => setLang('zh'));
  assert.equal(document.querySelector('[aria-label="确认优先级请求"] strong').textContent, '本会应用：改为现在做');
  await act(async () => setLang('en')); await click('Collapse');
  failure = new ApiError('优先级面板已关闭', 403);
  await click('Adjust'); await click('Record for this session: Do now');
  assert.doesNotMatch(panelText(), /[\\u4e00-\\u9fff]/);
  assert.ok(panelText().includes('Operation failed; refresh to verify'));
  failure = new ApiError('优先级版本冲突', 409);
  await click('Adjust'); await click('Record for this session: Do now');
  assert.ok(panelText().includes('Version changed; refresh and try again'));
  await click('Priority history');
  assert.ok(panelText().includes('Record for this session: Change to Do now'));
  failure = null;
  data.modes.priorityPanel.mode = 'on'; await render();
  await click('Adjust'); await click('Do now');
  assert.equal(document.querySelector('[aria-label="Confirm priority request"] strong').textContent, 'Change to Do now');
  props.error = '读取中文错误'; await render();
  assert.doesNotMatch(panelText(), /[\\u4e00-\\u9fff]/);
`));


test('UXTERM6: translate history action labels without rewriting owner words', () => {
  expect(priorityHistoryText('本会应用：改为现在做；owner 补充原话', 'en'))
    .toBe('Record for this session: Change to Do now；owner 补充原话');
  expect(priorityHistoryText('同档前移', 'en')).toBe('Move up within band');
  expect(priorityHistoryText('恢复继承', 'en')).toBe('Restore inheritance');
  expect(priorityHistoryText('owner 补充原话', 'en')).toBe('owner 补充原话');
  expect(priorityHistoryText('本会应用：改为现在做', 'zh')).toBe('本会应用：改为现在做');
});
