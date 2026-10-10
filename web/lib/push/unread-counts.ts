import { fetchUnread } from "@/lib/api/push";
import { ApiError } from "@/lib/api/client";
import { machines } from "@/lib/machines";

interface UnreadSnapshot { counts: Record<string, number>; total: number }
interface MachineUnread { snapshot: UnreadSnapshot; denied: boolean }
const EMPTY: UnreadSnapshot = { counts: {}, total: 0 };
const perMachine = new Map<string, MachineUnread>();
let state = EMPTY;
let activeKey = machines.currentFp() ?? "";
let generation = 0;
let requestSequence = 0;
let appliedSequence = 0;
const subs = new Set<() => void>();
const keyOf = () => machines.currentFp() ?? "";
function machine(key: string): MachineUnread {
  let r = perMachine.get(key);
  if (!r) { r = { snapshot: EMPTY, denied: false }; perMachine.set(key, r); }
  return r;
}
function publish(snapshot: UnreadSnapshot): void {
  state = snapshot;
  for (const cb of subs) cb();
}
export function setUnreadCounts(counts: Record<string, number>): void {
  const snapshot = { counts, total: Object.values(counts).reduce((n, x) => n + x, 0) };
  machine(keyOf()).snapshot = snapshot;
  publish(snapshot);
}
export function clearUnreadCounts(): void {
  generation++;
  setUnreadCounts({});
}
machines.onSwitch((_prev, next) => {
  activeKey = next ?? "";
  generation++;
  publish(EMPTY);
});

/** Optional data never makes an otherwise successful agent list fail. Responses belong to their captured machine. */
export async function loadUnreadCounts(signal?: AbortSignal, timeoutMs = 5000): Promise<Record<string, number>> {
  const key = keyOf(), saved = machine(key);
  if (activeKey !== key) { activeKey = key; generation++; publish(EMPTY); }
  if (saved.denied) { publish(saved.snapshot); return saved.snapshot.counts; }
  const epoch = generation, seq = ++requestSequence;
  try {
    const counts = await fetchUnread(signal, timeoutMs);
    if (epoch !== generation || key !== keyOf()) return {};
    // Concurrent list/foreground requests remain valid; only a newer applied response supersedes these counts.
    if (seq > appliedSequence) { appliedSequence = seq; setUnreadCounts(counts); }
  } catch (err) {
    // Missing route / offline / timeout retains this machine's last counts. 403 stops only this machine's polling.
    if (epoch !== generation || key !== keyOf()) return {};
    if (err instanceof ApiError && err.status === 403) saved.denied = true;
    publish(saved.snapshot);
  }
  return saved.snapshot.counts;
}
export const unreadSnapshot = (): UnreadSnapshot => state;
export function subscribeUnread(cb: () => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}
