'use client';
import type { ReactNode } from 'react';
import { sharedIdentity } from '../team-source-key';
export { sharedCollabProject } from '../team-source-key';
import { TeamSource } from '../shared/team-ops';
/** The independent sidebar entry now owns N4's verified names/bindings, including projects with no local agent rows. */
export function SharedEntry(_props: { projectId: string }) {
  return null;
}
export function SharedCollabContent({ project, fallback }: { project: string; fallback: ReactNode }) {
  const identity = sharedIdentity(project);
  // 团队视图就是本地 CollabView（fallback），只是数据换成中心共享台账（i28-TV1）
  return identity ? <TeamSource identity={identity}>{fallback}</TeamSource> : fallback;
}
