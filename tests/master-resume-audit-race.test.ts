/**
 * hardening-MRESUME1：交接单「先原子认领，只消费读到的那一代」。
 * 只用临时目录里的真实文件；barrier / 失败经 takeMasterResume 的 io 注入。
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, existsSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { MASTER_RESUME_MAX_AGE_MS, takeMasterResume, writeMasterResume } from "../src/lib/master-session";

const SID_A = "aaaaaaaa-1b77-4d0e-9a55-6c8f0e2b7a31";
const SID_B = "bbbbbbbb-1b77-4d0e-9a55-6c8f0e2b7a31";

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), "cstra-mresume-")), "master-resume.json");
}

const ioErr = (code: string) => Object.assign(new Error(code), { code });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("takeMasterResume 代次", () => {
  it("[验收线 1] 取得 A 后 writer 写 B：返回 A，下一次仍取到 B", async () => {
    const path = freshPath();
    expect(await writeMasterResume(SID_A, "a", path)).toBe(true);
    let fired = false;
    const got = await takeMasterResume(path, Date.now(), MASTER_RESUME_MAX_AGE_MS, {
      readFile: async (p, enc) => {
        const raw = await readFile(p, enc);
        if (!fired) {
          fired = true;
          // barrier：consumer 已读到 A，另一个 writer 此刻完整写下 B
          expect(await writeMasterResume(SID_B, "b", path)).toBe(true);
        }
        return raw;
      },
    });
    expect(got?.sessionId).toBe(SID_A);
    expect((await takeMasterResume(path))?.sessionId).toBe(SID_B);
    expect(await takeMasterResume(path)).toBeNull();
  });

  it("[验收线 2] 两个 consumer 竞争同一代只有一个拿到", async () => {
    const path = freshPath();
    await writeMasterResume(SID_A, "a", path);
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    const io = {
      readFile: async (p: string, enc: "utf8") => {
        const raw = await readFile(p, enc);
        if (++arrived === 2) release();
        await Promise.race([both, sleep(50)]); // 两人都读到再往下走；只有一人能读时不卡死
        return raw;
      },
    };
    const res = await Promise.all([
      takeMasterResume(path, Date.now(), MASTER_RESUME_MAX_AGE_MS, io),
      takeMasterResume(path, Date.now(), MASTER_RESUME_MAX_AGE_MS, io),
    ]);
    expect(res.filter((r) => r?.sessionId === SID_A)).toHaveLength(1);
    expect(res.filter((r) => r === null)).toHaveLength(1);
    expect(await takeMasterResume(path)).toBeNull();
  });

  it("[验收线 2] 认领(rename)失败：返回 null，不删文件，下次还能取", async () => {
    const path = freshPath();
    await writeMasterResume(SID_A, "a", path);
    const got = await takeMasterResume(path, Date.now(), MASTER_RESUME_MAX_AGE_MS, {
      rename: async () => { throw ioErr("EIO"); },
    });
    expect(got).toBeNull();
    expect(existsSync(path)).toBe(true);
    expect((await takeMasterResume(path))?.sessionId).toBe(SID_A);
  });

  it("[验收线 2] 认领后读失败：放回原路径可再取，不留认领文件", async () => {
    const path = freshPath();
    await writeMasterResume(SID_A, "a", path);
    const got = await takeMasterResume(path, Date.now(), MASTER_RESUME_MAX_AGE_MS, {
      readFile: async () => { throw ioErr("EIO"); },
    });
    expect(got).toBeNull();
    expect(readdirSync(dirname(path))).toEqual(["master-resume.json"]);
    expect((await takeMasterResume(path))?.sessionId).toBe(SID_A);
  });

  it("[验收线 2] 读失败期间来了新一代 B：不拿旧的覆盖 B，B 照常可取", async () => {
    const path = freshPath();
    await writeMasterResume(SID_A, "a", path);
    const got = await takeMasterResume(path, Date.now(), MASTER_RESUME_MAX_AGE_MS, {
      readFile: async () => {
        await writeMasterResume(SID_B, "b", path);
        throw ioErr("EIO");
      },
    });
    expect(got).toBeNull();
    expect((await takeMasterResume(path))?.sessionId).toBe(SID_B);
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it("[验收线 2] 过期 / 非法记录取一次就消费掉，不无限重试", async () => {
    const path = freshPath();
    await writeMasterResume(SID_A, "a", path);
    const later = Date.now() + MASTER_RESUME_MAX_AGE_MS + 1_000;
    expect(await takeMasterResume(path, later)).toBeNull();
    expect(readdirSync(dirname(path))).toEqual([]);

    writeFileSync(path, "{ not json");
    expect(await takeMasterResume(path)).toBeNull();
    expect(readdirSync(dirname(path))).toEqual([]);
    expect(await takeMasterResume(path)).toBeNull();
  });

  it("[验收线 2] 正常 handoff 兼容：默认参数取走即删，不留认领文件", async () => {
    const path = freshPath();
    await writeMasterResume(SID_A, "a", path);
    expect((await takeMasterResume(path))?.sessionId).toBe(SID_A);
    expect(readdirSync(dirname(path))).toEqual([]);
  });
});
