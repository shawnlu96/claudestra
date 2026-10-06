/** Isolated browser fixture for real team navigation; production code never imports this entry. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { machines } from '@/lib/machines';
import { CollabEntry } from '../collab-entry';
import { useCollabNav } from '../collab-nav';
import { SharedCollabContent } from './shared-navigation';

function Preview() {
  const { project } = useCollabNav();
  return <div><ul><CollabEntry projectId="project-a" /></ul>
    {project && <SharedCollabContent project={project} fallback={<p>Local ledger</p>} />}</div>;
}
async function mount() {
  await machines.load();
  await machines.add({ fp: 'c5-machine', name: 'Fixture machine', principalId: 'guest:member' });
  await machines.setCurrent('c5-machine');
  createRoot(document.getElementById('root')!).render(<Preview />);
}
void mount();
