import { api } from './client';
import { assertProductBoard, type ProductBoard } from './product-board-types';
export type { ProductBoard, ProductFeature } from './product-board-types';

export async function fetchProductBoard(project: string, signal?: AbortSignal): Promise<ProductBoard> {
  const board = await api<unknown>(`/ledger/${encodeURIComponent(project)}/product`, { timeoutMs: 10_000, signal });
  assertProductBoard(board);
  return board;
}
