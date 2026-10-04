/**
 * `manager state-backup restore` 必须真拿到 principals 锁才写：锁被另一个持有者占着（真 acquireLock 建的 principals.json.lock/owner）时
 * 拒绝恢复、什么都不写。只 import 两版都有的东西，同一条用例能在旧实现上跑（旧实现拿不到锁照样恢复）。临时 CLAUDESTRA_STATE_DIR 里起子进程。
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { principalsLockPath } from "../src/lib/principals.js";
import { listSnapshots, takeSnapshot } from "../src/lib/state-backup.js";

test("principals 锁被另一个持有者占着：restore 拒绝，principals.json 和快照都不动，锁仍是对方的", async () => {
  const d = mkdtempSync(join(tmpdir(), "state-backup-lock-"));
  const file = join(d, "principals.json");
  writeFileSync(file, "good");
  const ts = takeSnapshot(d).ts!;
  writeFileSync(file, "bad");
  const holder = (await acquireLock(principalsLockPath(file)))!;
  try {
    expect(readFileSync(join(`${file}.lock`, "owner"), "utf8")).toBe(holder.token);
    const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: d };
    delete env.DISCORD_CHANNEL_ID;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/manager.ts"), "state-backup", "restore", ts, "principals.json"],
      { env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const r = JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: false });
    expect(readFileSync(file, "utf8")).toBe("bad");
    expect(listSnapshots(d)).toHaveLength(1);
    expect(holder.held()).toBe(true);
  } finally {
    holder.release();
    rmSync(d, { recursive: true, force: true });
  }
}, 40_000);
