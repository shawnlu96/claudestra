/** Recovery must address the same worker name even when creation stopped before a session was recorded. */
import { createHash } from "node:crypto";

export const workerName = (orderId: string): string => `agent-lend-${createHash("sha256").update(orderId).digest("hex").slice(0, 10)}`;
