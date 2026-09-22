import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "fs";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MASTER_RESUME_MAX_AGE_MS,
  parseMasterResume,
  takeMasterResume,
  writeMasterResume,
} from "../src/lib/master-session";

const SID = "3f2a91c4-1b77-4d0e-9a55-6c8f0e2b7a31";

describe("parseMasterResume", () => {
  const now = 1_700_000_000_000;

  it("接受刚写下的单子", () => {
    const raw = JSON.stringify({ sessionId: SID, recordedAt: now - 5_000, reason: "relogin" });
    expect(parseMasterResume(raw, now)?.sessionId).toBe(SID);
  });

  it("过期的单子当没有（陈年 id 会把大总管拽回不相干的上下文）", () => {
    const raw = JSON.stringify({ sessionId: SID, recordedAt: now - MASTER_RESUME_MAX_AGE_MS - 1 });
    expect(parseMasterResume(raw, now)).toBeNull();
  });

  it("未来时间戳也当过期（手写的单子不能有无限有效期）", () => {
    const raw = JSON.stringify({ sessionId: SID, recordedAt: now + MASTER_RESUME_MAX_AGE_MS + 1 });
    expect(parseMasterResume(raw, now)).toBeNull();
  });

  it("坏 JSON / 缺字段 / 怪 id 一律 null", () => {
    expect(parseMasterResume("not json", now)).toBeNull();
    expect(parseMasterResume(JSON.stringify({ recordedAt: now }), now)).toBeNull();
    expect(parseMasterResume(JSON.stringify({ sessionId: SID }), now)).toBeNull();
    // 拼进启动命令的东西只走白名单
    expect(parseMasterResume(JSON.stringify({ sessionId: "a; rm -rf /", recordedAt: now }), now)).toBeNull();
    expect(parseMasterResume(JSON.stringify({ sessionId: "short", recordedAt: now }), now)).toBeNull();
  });
});

describe("takeMasterResume", () => {
  it("取走即删：第二次读不到（resume 失败不会无限重试）", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cstra-master-")), "master-resume.json");
    expect(await writeMasterResume(SID, "test", path)).toBe(true);

    expect((await takeMasterResume(path))?.sessionId).toBe(SID);
    expect(existsSync(path)).toBe(false);
    expect(await takeMasterResume(path)).toBeNull();
  });

  it("过期的单子也照样删掉", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cstra-master-")), "master-resume.json");
    await writeMasterResume(SID, "test", path);

    const later = Date.now() + MASTER_RESUME_MAX_AGE_MS + 1_000;
    expect(await takeMasterResume(path, later)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("没有单子 = null（崩溃/开机走原来的全新会话）", async () => {
    expect(await takeMasterResume(join(tmpdir(), "cstra-no-such-resume.json"))).toBeNull();
  });

  it("不合法的 id 不写单子", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cstra-master-")), "master-resume.json");
    expect(await writeMasterResume("bad id!", "test", path)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});
