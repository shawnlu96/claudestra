/**
 * 借入方管理面的接口（bridge/local-api/lend-peers-view.ts）：GET /borrow 读全貌，PUT / DELETE /borrow/peers/:peer 改一条借入。
 * 读回 403（不是 owner 的全权设备）或 404（老 bridge 没这个端点）→ null，面板整块不渲染。形状与 bridge 一致（web 与 src 互不 import）。
 */
import { api, ApiError } from "@/lib/api/client";
import { machines, type MachineRef } from "@/lib/machines";
import { peerSaver, type PeerSaver } from "./borrow-model";

export type Family = "codex" | "claude";
export type RemoteModeView = "balance" | "off";
export interface BorrowEntry { peer: string; fp?: string; projects: string[]; roles: string[]; maxOpen: number }
export type DroppedCode = "contact_gone" | "contact_disabled" | "fp_changed" | "project_gone" | "personal";
export interface DroppedView { peer: string; project?: string; code: DroppedCode }
export interface PeerCapacity { peer: string; proto: number; helloAt: number | null; open: number; slots: Record<Family, number>; why: string | null }
export interface PeerView {
  peer: string;
  maxOpen: number;
  projects: string[];
  capacity: PeerCapacity | null;
  reported: Record<Family, { total: number; busy: number }> | null;
  paused: { reason: string; until: number } | null;
  grant: { roles: string[]; repos: string[]; until: number; ordersLeftToday: number } | null;
}
export interface RemoteRow {
  orderId: string; taskId: string; title: string | null; project: string; peer: string; family: string; step: string; status: string;
  leaseUntil: number | null; beatAt: number | null; phase: string | null;
}
export interface BorrowView {
  now: number;
  schedulerOk: boolean;
  projects: { id: string; mode: RemoteModeView; maxActiveWorkers: number }[];
  borrow: {
    file: "ok" | "missing" | "invalid";
    invalid: boolean;
    declared: BorrowEntry[];
    effective: BorrowEntry[];
    dropped: DroppedView[];
    contacts: string[];
    projects: { id: string; name: string }[];
    maxOpenLimit: number;
  };
  ledger: boolean;
  peers: PeerView[];
  remote: RemoteRow[];
}

/** null = 这台设备 / 这个 bridge 没有借入面（403 / 404）；其余错误照抛 */
export async function fetchBorrow(signal?: AbortSignal): Promise<BorrowView | null> {
  try {
    return await api<BorrowView>("/borrow", { signal, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

const peerPath = (peer: string) => `/borrow/peers/${encodeURIComponent(peer)}`;

/** CLI 准入不过也会抛（409 refused）：调用方按失败回弹。machine 缺省 = 发请求时的当前机器 */
export async function saveBorrowPeer(peer: string, body: BorrowBody, machine?: MachineRef): Promise<void> {
  await api(peerPath(peer), { method: "PUT", json: body, timeoutMs: 40_000 }, machine);
}

export async function removeBorrowPeer(peer: string, machine?: MachineRef): Promise<void> {
  await api(peerPath(peer), { method: "DELETE", timeoutMs: 40_000 }, machine);
}

type BorrowBody = { projects: string[]; maxOpen: number };
/** 写给哪台机器的哪个 peer：在提交那一刻定下，停手计时、排队中的写和删后记号都跟着来源机器，切机器后不写到另一台、也不串删除状态 */
interface Aim { machine?: MachineRef; peer: string }
const lanes = peerSaver<Aim, BorrowBody>(
  { put: (a, v) => saveBorrowPeer(a.peer, v, a.machine), del: (a) => removeBorrowPeer(a.peer, a.machine) },
  (a) => JSON.stringify([a.machine?.fp ?? null, a.peer]),
);
const aim = (peer: string): Aim => {
  const fp = machines.currentFp();
  return fp ? { machine: { fp }, peer } : { peer };
};

/** 借入 peer 的写入一律经它：按（机器，peer）串行、最后提交的赢，删掉的不复活（borrow-model.ts peerSaver）。模块级，卡片换几次都是这一份 */
export const borrowSaver: PeerSaver<string, BorrowBody> = {
  save: (peer, v, after, delayMs) => lanes.save(aim(peer), v, after, delayMs),
  remove: (peer) => lanes.remove(aim(peer)),
  create: (peer, v) => lanes.create(aim(peer), v),
};
