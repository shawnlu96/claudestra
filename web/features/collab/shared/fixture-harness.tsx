/**
 * 截图入口（只给 tests/web-shared-ledger-browser.test.ts 打包用，生产导航不 import）：?side=local 是本地协作视图，
 * ?side=team 是同一个 CollabView 套上团队数据源。两边的数据都由测试服务器按 /api/v1/ledger/* 与 /api/v1/shared-ledger/* 给。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatStoreProvider } from '../../chat/chat-store';
import { CollabView } from '../collab-view';
import { sharedCollabProject } from '../dag/shared-navigation';
import { TeamSource } from './team-ops';

const params = new URLSearchParams(location.search);
const project = params.get('project') ?? 'claude-orchestrator';
const identity = { center: 'center', team: params.get('team') ?? 'team-a', person: 'person-a', project, machine: 'local' };

function Harness() {
  return <ChatStoreProvider>
    <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
      {params.get('side') === 'team'
        ? <TeamSource identity={identity}><CollabView project={sharedCollabProject(identity)} /></TeamSource>
        : <CollabView project={project} />}
    </div>
  </ChatStoreProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
