/**
 * Which members a merge train may release together (dispatch-recovery-TRAINSET1). A green car proves only its own members on the
 * train's base: two green halves of a red car say nothing about their union (AB green, C green, yet A+C red). So the bisect only
 * locates and bounces; `cleared` while testing is the local result, and nothing is released without a joint `proof`:
 * - one green car carried every surviving member (the first car, or the only green half): that car is the proof, no extra CI;
 * - survivors spread over several green cars: one confirmation car is built from the same base and their exact heads. Green =
 *   it is the proof and the cars it replaces turn `partial`; red (or timed out) = every survivor goes serial with a PM alarm,
 *   the disjoint green cars are never stitched together.
 * The proof is saved with the state, and the confirmation is derived from the saved cars, so a restart between the local greens
 * and the confirmation car still builds it. A settling state whose `cleared` no saved proof covers (an older build's state, a
 * moved base or head) is refused: its unmerged members go serial. Only a lone cleared member needs no car, there is no union.
 */
import type { TrainCar, TrainDeps, TrainEventKind, TrainState } from "./scheduler-merge-train.js";

/** `car` = the green car whose CI ran exactly these heads on `base`; null only for a lone member of a state saved without cars. */
export interface TrainProof { car: string | null; base: string; heads: Record<string, string> }

type Io = Pick<TrainDeps, "store" | "now" | "notify">;
/** The engine's own steps, lent the way train-ci-timeout.ts takes them. */
export interface SetOps<D> {
  emit(s: TrainState, deps: D, kind: TrainEventKind, text: string, data?: Record<string, unknown>, notify?: boolean, alarm?: boolean): Promise<void>;
  save(s: TrainState, deps: D): void;
  toSerial(s: TrainState, deps: D, ids: readonly string[], why: string): Promise<void>;
  newCar(s: TrainState, id: string, level: number, parent: string | null, members: string[], now: number): TrainCar;
}

const eq = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const headOf = (s: TrainState, id: string) => s.members.find((m) => m.taskId === id)?.head;
const list = (ids: readonly string[]) => ids.join("、") || "（无）";

/** Locally green members still riding, in batch order: what the train would release if their union held. */
const survivors = (s: TrainState): string[] => s.members.map((m) => m.taskId)
  .filter((id) => s.cleared.includes(id) && !s.serial.includes(id) && !s.bounced.some((b) => b.taskId === id));

/** The joint proof the saved cars give for `ids`: a green car that carried all of them (the confirmation car first). Pure. */
export function proofFor(s: TrainState, ids: readonly string[]): TrainProof | null {
  if (!ids.length || ids.some((id) => !headOf(s, id))) return null;
  const covers = (c: TrainCar) => c.status === "green" && ids.every((id) => c.members.includes(id));
  const car = s.cars.find((c) => c.confirm && covers(c)) ?? s.cars.find(covers);
  if (!car && (ids.length !== 1 || s.cars.length)) return null;
  const carried = (car?.members ?? ids).filter((id) => headOf(s, id));
  return { car: car?.id ?? null, base: s.base, heads: Object.fromEntries(carried.map((id) => [id, headOf(s, id)!])) };
}

/** The saved proof still stands: same base, its car still green, every cleared member in it at the head it tested. */
function holds(s: TrainState, p: TrainProof): boolean {
  if (!eq(p.base, s.base)) return false;
  const car = p.car === null ? null : s.cars.find((c) => c.id === p.car);
  if (p.car === null ? s.cleared.length > 1 : car?.status !== "green") return false;
  return s.cleared.every((id) => eq(p.heads[id], headOf(s, id) ?? "") && (!car || car.members.includes(id)));
}

/** Every cleared member may be released: the saved proof holds, or (a state saved without one) its cars still give one. */
export const jointlyProven = (s: TrainState): boolean => (s.proof ? holds(s, s.proof) : !!proofFor(s, s.cleared));

/** Heads main may have gained since the base: the members the proof covers, none when it does not hold. */
export const provenHeads = (s: TrainState): string[] =>
  (jointlyProven(s) ? s.cleared.map((id) => headOf(s, id)!.toLowerCase()) : []);

/** Record `p` as the train's proof; green cars it replaces turn `partial`, so the car a member merges on is the proof car. */
function seal(s: TrainState, p: TrainProof, ids: readonly string[]): void {
  s.proof = p; s.cleared = [...ids];
  for (const c of s.cars) if (c.status === "green" && c.id !== p.car) c.status = "partial";
}

/**
 * No car is running and nothing is lost: may testing end? True = `cleared` is exactly the jointly proven set (possibly empty).
 * False = the confirmation car was queued for the next tick. A train confirms once: a second unproven set goes serial.
 */
export async function settleSet<D extends Io>(s: TrainState, deps: D, ops: SetOps<D>): Promise<boolean> {
  const ids = survivors(s), p = proofFor(s, ids);
  if (!ids.length || p) {
    if (p) seal(s, p, ids); else s.cleared = [];
    ops.save(s, deps);
    const car = s.cars.find((c) => c.id === p?.car);
    if (car?.confirm) await ops.emit(s, deps, "confirm", `确认车 ${car.id}（${list(ids)}）整体 CI 绿，逐张放行`, { car: car.id, members: ids, result: "green" }, true);
    return true;
  }
  if (s.cars.some((c) => c.confirm)) {
    await unproven(s, deps, ops, ids, "确认车没有给出这组成员的联合证明");
    return true;
  }
  const car: TrainCar = { ...ops.newCar(s, `${s.id}-set`, 0, null, ids, deps.now()), confirm: true };
  s.cars.push(car);
  ops.save(s, deps);
  await ops.emit(s, deps, "confirm", `二分后 ${list(ids)} 分属不同绿色车厢，各自绿不等于一起绿：同一起点 main 加它们的 head 拼确认车 ${car.id}，整体绿才放行`,
    { car: car.id, members: ids, base: s.base }, true);
  return false;
}

/** `ids` have no joint proof: none of them is released by this train, each goes serial and judges itself against current main. */
async function unproven<D extends Io>(s: TrainState, deps: D, ops: SetOps<D>, ids: readonly string[], why: string): Promise<void> {
  s.cleared = s.cleared.filter((id) => !ids.includes(id));
  await ops.toSerial(s, deps, ids, why);
  ops.save(s, deps);
  await ops.emit(s, deps, "alarm", `${why}：${list(ids)} 回串行路径，各自按当前 main 重新核，请 PM 看看`, { members: [...ids], reason: why }, true, true);
}

/** The confirmation car came back red or timed out: the union fails though each part passed, so no part's green is used. */
export async function confirmFailed<D extends Io>(s: TrainState, car: TrainCar, deps: D, ops: SetOps<D>, what: string): Promise<void> {
  const ids = [...new Set([...car.members, ...survivors(s)])];
  await unproven(s, deps, ops, ids, `确认车 ${car.id} 整体${what}，局部绿拼不成联合证明`);
}

/**
 * Settling fail-closed: cleared members still to merge without a joint proof (a state an older build saved, or one whose proof no
 * longer matches base / heads) leave the train for the serial path. A state saved without a proof adopts the one its cars give.
 * Returns whether the train may go on releasing.
 */
export async function ensureProof<D extends Io>(s: TrainState, deps: D, ops: SetOps<D>): Promise<boolean> {
  const left = s.cleared.filter((id) => !s.merged.some((m) => m.taskId === id) && !s.dropped.includes(id));
  if (!left.length) return true;
  if (jointlyProven(s)) {
    if (!s.proof) { s.proof = proofFor(s, s.cleared)!; ops.save(s, deps); }
    return true;
  }
  await unproven(s, deps, ops, left, "状态里没有这些成员一起通过 CI 的联合证明");
  return false;
}
