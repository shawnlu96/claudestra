/** Browser mirror for the five editor command bodies. The local API also runs the frozen server parser. */
import type { ExecCommand } from './shared-ledger-v2';
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const integer = (v: unknown, min = 1) => Number.isSafeInteger(v) && Number(v) >= min;
const text = (v: unknown, max: number, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function shape(v: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid_field');
  const o = v as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !required.includes(k) && !optional.includes(k)))
    throw new Error('invalid_field');
  return o;
}
function spec(v: unknown): boolean {
  const s = shape(v, ['summary', 'originalDigest', 'sharedDigest', 'artifactId', 'visibility', 'repositoryPath', 'commit']);
  return text(s.summary, 16000) && digest(s.originalDigest) && (s.visibility === 'home_only'
    ? s.sharedDigest === null && s.artifactId === null : s.visibility === 'approved_copy' && digest(s.sharedDigest) && id(s.artifactId))
    && (s.repositoryPath === null || typeof s.repositoryPath === 'string' && !s.repositoryPath.startsWith('/')
      && !s.repositoryPath.split('/').includes('..')) && (s.commit === null || typeof s.commit === 'string' && /^[a-f0-9]{40}$/.test(s.commit));
}
export function parseCommand(value: unknown): ExecCommand {
  const c = shape(value, ['teamId', 'projectId', 'serviceGeneration', 'epoch', 'bootId', 'requestId', 'type', 'payload']);
  if (![c.teamId, c.projectId, c.bootId, c.requestId].every(id) || !integer(c.serviceGeneration) || !integer(c.epoch))
    throw new Error('invalid_field');
  let valid = false;
  if (c.type === 'task.new') {
    const p = shape(c.payload, ['featureId', 'expectedRev', 'itemId', 'title', 'plan', 'kind', 'repository', 'spec']);
    valid = id(p.featureId) && integer(p.expectedRev) && (p.itemId === null || id(p.itemId)) && text(p.title, 300, 1)
      && text(p.plan, 16000) && ['code', 'investigate', 'ops'].includes(String(p.kind)) && typeof p.repository === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p.repository) && spec(p.spec);
  } else if (c.type === 'task.set' || c.type === 'task.spec') {
    const p = shape(c.payload, ['taskId', 'expectedRev', 'expectedSpecRev', ...(c.type === 'task.set' ? ['patch'] : ['nextSpecRev', 'spec', 'reason'])]);
    valid = id(p.taskId) && integer(p.expectedRev) && integer(p.expectedSpecRev);
    if (c.type === 'task.set') {
      const patch = shape(p.patch, [], ['title', 'plan']);
      valid &&= Object.keys(patch).length > 0 && (patch.title === undefined || text(patch.title, 300, 1))
        && (patch.plan === undefined || text(patch.plan, 16000));
    } else valid &&= p.nextSpecRev === Number(p.expectedSpecRev) + 1 && spec(p.spec) && text(p.reason, 2000, 1);
  } else if (c.type === 'ask.answer') {
    const p = shape(c.payload, ['askId', 'expectedRev', 'bindDigest', 'answer', 'decision']);
    const kind = p.answer && typeof p.answer === 'object' ? (p.answer as Record<string, unknown>).kind : null;
    const answer = shape(p.answer, kind === 'option' ? ['kind', 'optionId'] : ['kind', 'text']);
    valid = id(p.askId) && integer(p.expectedRev) && digest(p.bindDigest) && ['approved', 'rejected', 'acknowledged'].includes(String(p.decision))
      && (answer.kind === 'option' ? id(answer.optionId) : answer.kind === 'text' && text(answer.text, 4000, 1));
  } else if (c.type === 'dag.decide') {
    const p = shape(c.payload, ['featureId', 'expectedRev', 'proposalId', 'proposalDigest', 'baseVersion', 'askId', 'decision']);
    valid = [p.featureId, p.proposalId, p.askId].every(id) && integer(p.expectedRev) && integer(p.baseVersion)
      && digest(p.proposalDigest) && ['approved', 'rejected'].includes(String(p.decision));
  }
  if (!valid) throw new Error('invalid_field');
  return value as ExecCommand;
}
