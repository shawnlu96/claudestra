'use client';
import { useState, type ComponentProps } from 'react';
import { localProjectOf } from '@/lib/collab-source-binding';
import { openCollab, openCollabTask } from '../collab-nav';
import { PriorityNodeDialog } from './priority-node-dialog';
import { WorkBoardContent } from '../work/work-board-view';
import { PriorityPanel } from './priority-panel';
import { usePriorityPanel } from './use-priority-panel';
import s from './priority-panel.module.css';

/** Keep the established board entry and card/node navigation, including the team page's local project binding. */
export function PriorityWorkBoard({ project, onPriorityNode, ...props }: ComponentProps<typeof WorkBoardContent> & {
  project: string; onPriorityNode: (feature: string, node: string) => void;
}) {
  const local = props.team ? localProjectOf(project) : project;
  const load = usePriorityPanel(local);
  const [node, setNode] = useState<{ feature: string; key: string } | null>(null);
  const task = (id: string) => {
    if (props.team && local) { openCollab(local); openCollabTask(id); setNode(null); }
    else props.onTask(id);
  };
  const openNode = (feature: string, key: string) => props.team ? setNode({ feature, key }) : onPriorityNode(feature, key);
  return <div className={s.workspace}><PriorityPanel key={local} project={local} {...load} onNode={openNode} onTask={task} />
    <div className={s.existing}><WorkBoardContent {...props} /></div>
    {node && local && <PriorityNodeDialog key={`${local}/${node.feature}/${node.key}`} project={local} feature={node.feature} nodeKey={node.key}
      onClose={() => setNode(null)} onTask={task} tr={props.tr} />}</div>;
}
