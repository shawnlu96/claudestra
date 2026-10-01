/**
 * 借入方管理面的接口（bridge/local-api/lend-peers-view.ts）：GET /borrow 读全貌，PUT / DELETE /borrow/peers/:peer 改一条借入。
 * 读回 403（不是 owner 的全权设备）或 404（老 bridge 没这个端点）→ null，面板整块不渲染。形状与 bridge 一致（web 与 src 互不 import）。
 */
import { api, ApiError } from "@/lib/api/client";

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

/** CLI 准入不过也会抛（409 refused）：调用方按失败回弹 */
export async function saveBorrowPeer(peer: string, body: { projects: string[]; maxOpen: number }): Promise<void> {
  await api(peerPath(peer), { method: "PUT", json: body, timeoutMs: 40_000 });
}

export async function removeBorrowPeer(peer: string): Promise<void> {
  await api(peerPath(peer), { method: "DELETE", timeoutMs: 40_000 });
}
