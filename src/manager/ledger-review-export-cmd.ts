/**
 * `ledger review-export <T> --out <dir>`: write the card's review history as a review-evidence v1 package (lib/review-evidence*.ts)
 * and run the local self-check on what was written. Read-only on the ledger (write-commands.ts READER_ONLY_SUBS); sends nothing —
 * delivery waits for the receiving instance's intake. ready:false lists why the package is not usable as evidence.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { instanceKeySync, keyFingerprint } from "../lib/instance-key.js";
import { getTask, LedgerError } from "../lib/ledger-store.js";
import { buildBundle } from "../lib/review-evidence.js";
import { collectSource, writeBundle } from "../lib/review-evidence-collect.js";
import { verifyBundle } from "../lib/review-evidence-verify.js";
import { reviewsDir } from "../lib/review-order.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

async function reviewExport(c: LedgerCli): Promise<Result> {
  const taskId = c.p.pos[1], out = c.p.flags.out;
  if (!taskId || !out || !isAbsolute(out)) throw new LedgerError("invalid", "要带 <task> --out <绝对路径目录>");
  const task = getTask(c.db, taskId);
  if (!task) throw new LedgerError("not_found", `没有任务 ${taskId}`);
  const key = instanceKeySync();
  if (!key) throw new LedgerError("invalid", "读不到本机实例密钥，导出不了实例指纹");
  const reg = await c.deps.loadRegistry();
  const head = c.p.flags.head ?? task.headSHA ?? "";
  const repoDir = c.p.flags.repo ?? c.deps.projects?.().find((p) => p.id === task.project)?.dirs[0] ?? process.cwd();
  const src = collectSource(c.db, taskId, { head, base: c.p.flags.base, repoDir, reviewsDir: reviewsDir(),
    registry: Object.entries(reg.agents).map(([name, a]) => ({ ...a, name })), fingerprint: keyFingerprint(key.publicKey),
    exporter: c.deps.actor, bundleId: `${taskId}-${head.slice(0, 12)}-${randomUUID()}`, now: c.deps.now() });
  const bundle = buildBundle(src);
  writeBundle(out, bundle);
  const v = verifyBundle(out);
  return { ok: true, dir: out, bundleId: src.bundleId, files: bundle.files.size + 1,
    manifestSha256: createHash("sha256").update(readFileSync(join(out, "manifest.json"))).digest("hex"),
    ready: v.ok, problems: v.problems, notes: bundle.notes };
}

export const REVIEW_EXPORT_CMDS: Record<string, CommandSpec> = {
  "review-export": {
    valued: ["out", "head", "base", "repo"],
    usage: "review-export <task> --out <空目录> [--head <sha>] [--base <sha>] [--repo <仓库目录>]（只读：导出审查证据包 v1 并自检，不发送）",
    run: reviewExport,
  },
};
