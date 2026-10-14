/**
 * 截图入口（只给 tests/web-shared-ledger-browser.test.ts、tests/web-team-parity-browser.test.ts 打包用，生产导航不 import）：
 * ?side=local 是本地协作视图，?side=team 是同一个 CollabView 套上团队数据源。两边的数据都由测试服务器按 /api/v1/ledger/* 与
 * /api/v1/shared-ledger/* 给。待办 store 照生产外壳（asks-entry.tsx）启动，否则「待你处理」两边都恒为 0，对照不出团队键对不上的问题。
 */
import React, { useEffect } from 'react';
import { asksStore } from '../../asks/asks-store';
import { createRoot } from 'react-dom/client';
import { ChatStoreProvider, useChatStoreApi } from '../../chat/chat-store';
import { CollabView } from '../collab-view';
import { sharedCollabProject } from '../dag/shared-navigation';
import { TeamSource } from './team-ops';

const params = new URLSearchParams(location.search);
const project = params.get('project') ?? 'claude-orchestrator';
const identity = { center: 'center', team: params.get('team') ?? 'team-a', person: 'person-a', project, machine: 'local' };

/** 会话列表照生产外壳（chat.tsx）挂载时读一次：详情里执行者在线 / 忙闲、「叫停这一轮」都看它 */
function SeedAgents() {
  const store = useChatStoreApi();
  useEffect(() => void store.loadAgents(), [store]);
  return null;
}

function Harness() {
  useEffect(() => asksStore.start('local'), []);
  return <ChatStoreProvider>
    <SeedAgents />
    <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
      {params.get('side') === 'team'
        ? <TeamSource identity={identity}><CollabView project={sharedCollabProject(identity)} /></TeamSource>
        : <CollabView project={project} />}
    </div>
  </ChatStoreProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
