/** The retire CLI caps steps at 20 × 400 chars; persist overflow before recording a short, complete reference for the PM. */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RetireRecord } from "./agent-lifecycle-store.js";
import { acquireLock } from "./file-lock.js";
import { writeJsonAtomic } from "./state-file.js";

/** Keep short records unchanged; an overflowing record must have a verified durable full report or fail without a partial event. */
export async function reportRetireSteps(r: RetireRecord, statePath: string): Promise<RetireRecord> {
  if (r.steps.length <= 20 && r.steps.every((s) => s.length <= 400)) return r;
  const data = { v: 1, agent: r.agent, sessionId: r.sessionId, regAt: r.regAt ?? null, pending: r.pending, steps: r.steps };
  const raw = JSON.stringify(data), digest = createHash("sha256").update(raw).digest("hex");
  const path = `${statePath}.report-${digest}.json`;
  const reference = `清理步骤 ${r.steps.length} 条（完整记录已持久核对）；完整清单：${path}`;
  if (reference.length > 400) throw new Error("清理完整报告路径超过台账步骤上限，拒绝写截断通知");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory()) throw new Error("清理完整报告父目录不是真实目录，不跟软链");
  const lock = await acquireLock(`${path}.lock`, 5_000);
  if (!lock) throw new Error("清理完整报告锁未取得，拒绝写不完整通知");
  try {
    const existing = await lstat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (existing && !existing.isFile()) throw new Error("清理完整报告不是普通文件，不跟软链或覆盖旧档");
    if (!existing) await writeJsonAtomic(path, data, { noFollow: true, mode: 0o600 });
    const current = await lstat(dirname(path)), final = await lstat(path);
    if (!current.isDirectory() || current.dev !== parent.dev || current.ino !== parent.ino || !final.isFile()) {
      throw new Error("清理完整报告目录或文件身份变化，拒绝记不完整通知");
    }
    if (JSON.stringify(JSON.parse(await readFile(path, "utf8"))) !== raw) throw new Error("清理完整报告内容不符，不覆盖旧档");
    return { ...r, steps: [reference] };
  } finally { lock.release(); }
}
