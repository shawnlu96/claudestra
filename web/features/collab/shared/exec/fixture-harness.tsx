/** Opt-in S2W screenshot harness: the production CollabView and TV1 source with synthetic execution wiring. */
import React, { useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatStoreProvider } from '../../../chat/chat-store';
import { CollabView } from '../../collab-view';
import { TeamSource } from '../team-ops';
import { CollabSourceContext } from '../../team-source-context';
import { sharedCollabProject } from '../../team-source-key';
import { execFixtureContext } from './exec-fixture';
const params = new URLSearchParams(location.search);
const identity = { center: 'center', team: 'team-a', person: 'person-a', project: 'claude-orchestrator', machine: 'local' };
function Wiring({ children }: { children: React.ReactNode }) {
  const source = useContext(CollabSourceContext)!;
  const wired = { ...source, sharedExec: { context: () => ({ ...execFixtureContext,
    mode: params.get('mode') === 'off' ? 'off' as const : 'on' as const }) } };
  return <CollabSourceContext.Provider value={params.get('mode') === 'absent' ? source : wired}>{children}</CollabSourceContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<ChatStoreProvider><TeamSource identity={identity}>
  <Wiring><div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
    <CollabView project={sharedCollabProject(identity)} />
  </div></Wiring>
</TeamSource></ChatStoreProvider>);
