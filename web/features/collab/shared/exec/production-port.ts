/**
 * UIEXEC1 · production ExecPort for the formal TeamSource entry. The context comes only from this machine's bridge
 * (GET /shared-exec/context, which re-checks Principal, switch, binding and fence on every call); a reply that names another
 * team or project, or carries anything outside ExecContext, is dropped. One port per TeamSource session, so a context can never
 * outlive its machine / person identity. Unknown or failed = null = no execution DOM.
 */
import { sharedExecContext } from '../../../../lib/api/shared-ledger-v2';
import type { Identity } from '../../../../lib/api/shared-ledger';
import { ApiError } from '../../../../lib/api/client';
import type { ExecContext, ExecPort } from './exec-model';

/** Re-read after this long, so a switch turned to off/observe reaches an open view without a reload. */
const CONTEXT_TTL_MS = 60_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
type Read = (featureId: string, signal: AbortSignal) => Promise<unknown>;
interface Entry { value: ExecContext | null; at: number; loading: boolean }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown, min: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

/** Rebuild the context field by field; a missing, mistyped or foreign field yields null. */
export function parseExecContext(raw: unknown, identity: Pick<Identity, 'team' | 'project'>): ExecContext | null {
  if (!isRecord(raw) || !isRecord(raw.scope) || !isRecord(raw.viewer) || !isRecord(raw.instanceNames)) return null;
  const { mode, localProjectId, repository } = raw, s = raw.scope, v = raw.viewer;
  if ((mode !== 'on' && mode !== 'observe') || typeof localProjectId !== 'string' || !ID.test(localProjectId)
    || s.teamId !== identity.team || s.projectId !== identity.project || !count(s.serviceGeneration, 1) || !count(s.epoch, 0)
    || typeof s.bootId !== 'string' || !s.bootId || (v.role !== 'owner' && v.role !== 'member') || typeof v.instanceId !== 'string'
    || typeof repository !== 'string' || !repository) return null;
  const names = Object.entries(raw.instanceNames);
  if (names.some(([, name]) => typeof name !== 'string')) return null;
  return { mode, localProjectId, repository, instanceNames: Object.fromEntries(names) as Record<string, string>,
    scope: { teamId: s.teamId, projectId: s.projectId, serviceGeneration: s.serviceGeneration as number, epoch: s.epoch as number,
      bootId: s.bootId }, viewer: { role: v.role, instanceId: v.instanceId } };
}

export interface ProductionExecPort extends ExecPort { activate(): void; close(): void }
/** `changed` re-renders the TeamSource consumers once a context arrives or is withdrawn. */
export function productionExecPort(identity: Identity, changed: () => void,
  read: Read = (featureId, signal) => sharedExecContext({ teamId: identity.team, projectId: identity.project, featureId },
    signal, { fp: identity.machine }), now: () => number = Date.now): ProductionExecPort {
  const entries = new Map<string, Entry>();
  let ctrl = new AbortController();
  const load = async (featureId: string, entry: Entry) => {
    const { signal } = ctrl;
    let value: ExecContext | null = null;
    try { value = parseExecContext(await read(featureId, signal), identity); }
    catch (e) {
      // off / revoked / unmapped is the bridge's own answer (ApiError) and simply means no context; only surprises are logged.
      if (!signal.aborted && !(e instanceof ApiError)) console.warn('Shared execution context unavailable', e);
    }
    if (signal.aborted || entries.get(featureId) !== entry) return;
    const before = JSON.stringify(entry.value);
    Object.assign(entry, { value, at: now(), loading: false });
    if (JSON.stringify(value) !== before) changed();
  };
  return {
    context(featureId) {
      if (!ID.test(featureId)) return null;
      let entry = entries.get(featureId);
      if (!entry) entries.set(featureId, entry = { value: null, at: -Infinity, loading: false });
      // Called during render: the read starts after it, never inside it.
      if (!entry.loading && !ctrl.signal.aborted && now() - entry.at >= CONTEXT_TTL_MS) {
        entry.loading = true; const e = entry; queueMicrotask(() => void load(featureId, e));
      }
      return entry.value;
    },
    // StrictMode and remounts close then reactivate; nothing read before the close is reused.
    activate() { if (ctrl.signal.aborted) ctrl = new AbortController(); },
    close() { ctrl.abort(); entries.clear(); },
  };
}
