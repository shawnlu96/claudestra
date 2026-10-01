import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveUnmanagedFile, restoreUnmanagedArchive, sweepIdleCodexSubSessions } from "../src/lib/unmanaged-archive";
import { sweepCodexSubsIfEnabled } from "../src/bridge/archive-sweeper";

// Codex 子线程结束 7 天自动归档：只动「够老、没人挂着、没被锁、没被用户恢复过」的子线程。全部在临时目录里造假会话
const base = mkdtempSync(join(tmpdir(), "codex-sub-archive-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-29T00:00:00Z");
const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** 每个用例一套独立的 ~/.codex（sessions + thread-writer-locks）、归档根、恢复清单 */
function world() {
  const root = mkdtempSync(join(base, "w-"));
  const codexRoot = join(root, ".codex", "sessions");
  const day = join(codexRoot, "2026", "09", "01");
  mkdirSync(day, { recursive: true });
  const locksDir = join(root, ".codex", "thread-writer-locks");
  mkdirSync(locksDir, { recursive: true });
  const opts = { codexRoot, locksDir, archiveRoot: join(root, "archived"), restoredIndex: join(root, "restored-sessions.json") };
  const write = (n: number, payload: object, ageDays: number, now = NOW) => {
    const p = join(day, `rollout-2026-09-01T00-00-00-${id(n)}.jsonl`);
    writeFileSync(p, JSON.stringify({ type: "session_meta", payload: { cwd: "/w", ...payload } }) + "\n");
    const t = (now - ageDays * DAY) / 1000;
    utimesSync(p, t, t);
    return p;
  };
  const sub = (n: number, parent: number, ageDays: number, extra: object = {}) =>
    write(n, { id: id(n), session_id: id(parent), parent_thread_id: id(parent), thread_source: "subagent", ...extra }, ageDays);
  return { root, opts, write, sub };
}

describe("sweepIdleCodexSubSessions：挑哪些收", () => {
  test("只归档 7 天没写的子线程；副本 mtime 是归档时刻，meta 记原路径和来由", async () => {
    const w = world();
    const main = w.write(1, { id: id(1), session_id: id(1) }, 30);
    const oldSub = w.sub(2, 1, 8);
    const freshSub = w.write(3, { id: id(3), session_id: id(1), thread_source: "guardian_review" }, 2);
    const r = await sweepIdleCodexSubSessions({ keep: new Set(), now: NOW, ...w.opts });
    expect(r.archived).toBe(1);
    expect(r.bytes).toBe(statSync(join(w.opts.archiveRoot, id(2), oldSub.split("/").pop()!)).size);
    expect(existsSync(oldSub)).toBe(false);
    for (const p of [main, freshSub]) expect(existsSync(p)).toBe(true);
    const dest = join(w.opts.archiveRoot, id(2));
    expect(Date.now() - statSync(join(dest, oldSub.split("/").pop()!)).mtimeMs).toBeLessThan(60_000); // 保留期从归档那一刻算
    const meta = JSON.parse(readFileSync(join(dest, ".meta.json"), "utf8"));
    expect(meta).toEqual({ kind: "unmanaged", originalPath: oldSub, runtime: "codex", cwd: "/w", sessionId: id(2), reason: "codex-sub-idle" });
  });

  test("codex exec 一次性会话闲置满天数也收；人开的主会话（cli / vscode）不动", async () => {
    const w = world();
    const oldShot = w.write(1, { id: id(1), session_id: id(1), source: "exec" }, 8);
    const freshShot = w.write(2, { id: id(2), session_id: id(2), source: "exec" }, 2);
    const human = w.write(3, { id: id(3), session_id: id(3), source: "vscode" }, 30);
    const r = await sweepIdleCodexSubSessions({ keep: new Set(), now: NOW, ...w.opts });
    expect(r.archived).toBe(1);
    expect(existsSync(oldShot)).toBe(false);
    for (const p of [freshShot, human]) expect(existsSync(p)).toBe(true);
  });

  test("审查复现：已纳管 agent 的主会话今天还在写，它 8 天前开的 subagent 不动", async () => {
    const w = world();
    w.write(1, { id: id(1), session_id: id(1) }, 0);
    const s = w.sub(2, 1, 8);
    const r = await sweepIdleCodexSubSessions({ keep: new Set([id(1)]), now: NOW, ...w.opts });
    expect(r.archived).toBe(0);
    expect(existsSync(s)).toBe(true);
  });

  test("根会话被挂着：挂在 subagent 下的自动审查线程（直接父不是根）也不动；线程自己被挂着也不动", async () => {
    const w = world();
    w.sub(2, 1, 30);
    const review = w.write(3, { id: id(3), session_id: id(1), parent_thread_id: id(2), thread_source: "guardian_review" }, 30);
    const self = w.sub(4, 9, 30);
    const r = await sweepIdleCodexSubSessions({ keep: new Set([id(1), id(4)]), now: NOW, ...w.opts });
    expect(r.archived).toBe(0);
    for (const p of [review, self]) expect(existsSync(p)).toBe(true);
  });

  test("持有线程写锁的不动：锁在线程自己或它的父线程上都算；锁释放后下一轮照常收", async () => {
    const w = world();
    const locked = w.sub(2, 1, 30);
    const parentLocked = w.sub(3, 5, 30);
    writeFileSync(join(w.opts.locksDir, `${id(2)}.lock`), "");
    writeFileSync(join(w.opts.locksDir, `${id(5)}.lock`), "");
    expect((await sweepIdleCodexSubSessions({ keep: new Set(), now: NOW, ...w.opts })).archived).toBe(0);
    for (const p of [locked, parentLocked]) expect(existsSync(p)).toBe(true);
    rmSync(join(w.opts.locksDir, `${id(2)}.lock`));
    expect((await sweepIdleCodexSubSessions({ keep: new Set(), now: NOW, ...w.opts })).archived).toBe(1);
    expect(existsSync(locked)).toBe(false);
  });
});

describe("恢复后不会被下一轮再收走", () => {
  test("归档 → 8 天后恢复（mtime 改成恢复时刻、记进恢复清单）→ 再过 8 天扫描：它留着，没恢复过的照收", async () => {
    const w = world();
    const s = w.sub(2, 1, 8);
    expect((await sweepIdleCodexSubSessions({ keep: new Set(), now: NOW, ...w.opts })).archived).toBe(1);
    const restoredAt = NOW + 8 * DAY;
    await restoreUnmanagedArchive(join(w.opts.archiveRoot, id(2)), { originalPath: s, sessionId: id(2) }, { now: restoredAt, restoredIndex: w.opts.restoredIndex });
    expect(existsSync(join(w.opts.archiveRoot, id(2)))).toBe(false);
    expect(statSync(s).mtimeMs).toBe(restoredAt);
    expect(JSON.parse(readFileSync(w.opts.restoredIndex, "utf8"))).toEqual({ [id(2)]: new Date(restoredAt).toISOString() });
    const other = w.sub(3, 1, 30);
    const r = await sweepIdleCodexSubSessions({ keep: new Set(), now: NOW + 16 * DAY, ...w.opts });
    expect(r.archived).toBe(1);
    expect(existsSync(s)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  test("恢复清单坏了：整轮不归档（宁可不收，也不能把恢复过的又收走）", async () => {
    const w = world();
    const s = w.sub(2, 1, 30);
    writeFileSync(w.opts.restoredIndex, "{bad");
    await expect(sweepIdleCodexSubSessions({ keep: new Set(), now: NOW, ...w.opts })).rejects.toThrow("已损坏");
    expect(existsSync(s)).toBe(true);
  });
});

describe("归档目录名来自文件内容，不能写出归档区", () => {
  test("payload.id 是 ../../escaped：跳过，原件留着，归档根外面什么都没写", async () => {
    const w = world();
    const evil = w.write(7, { id: "../../escaped", session_id: id(1), parent_thread_id: id(1), thread_source: "subagent" }, 30);
    const r = await sweepIdleCodexSubSessions({ keep: new Set(), now: NOW, ...w.opts });
    expect(r.archived).toBe(0);
    expect(existsSync(evil)).toBe(true);
    expect(existsSync(join(w.root, "escaped"))).toBe(false);
    expect(existsSync(join(w.opts.archiveRoot, "..", "..", "escaped"))).toBe(false);
  });

  test("归档根下同名目录是指向外面的软链：拒绝写入，外面没有副本、原件还在", async () => {
    const w = world();
    const s = w.sub(2, 1, 30);
    const outside = join(w.root, "outside");
    mkdirSync(outside);
    mkdirSync(w.opts.archiveRoot, { recursive: true });
    symlinkSync(outside, join(w.opts.archiveRoot, id(2)));
    await expect(archiveUnmanagedFile(s, { sessionId: id(2), runtime: "codex" }, w.opts.archiveRoot)).rejects.toThrow("不在归档根下");
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(s)).toBe(true);
  });

  test("会话 id 不合法直接拒绝（手动归档路由同一套白名单）", async () => {
    const w = world();
    const s = w.sub(2, 1, 30);
    await expect(archiveUnmanagedFile(s, { sessionId: "../x" }, w.opts.archiveRoot)).rejects.toThrow("不合法");
    expect(existsSync(s)).toBe(true);
  });
});

describe("副本 mtime = 归档时刻（保留期从这一刻算）", () => {
  test("大文件（Bun 在 macOS 上 copyFile 走 clonefile、会带上原 mtime）：副本 mtime 也是现在", async () => {
    const w = world();
    const src = w.sub(2, 1, 60);
    writeFileSync(src, Buffer.alloc(3 * 1024 * 1024, 97)); // 小文件 copyFile 本来就换 mtime，测不出来
    const old = (Date.now() - 60 * DAY) / 1000;
    utimesSync(src, old, old);
    const dest = await archiveUnmanagedFile(src, { sessionId: id(2), runtime: "codex" }, w.opts.archiveRoot);
    expect(Date.now() - statSync(join(dest, src.split("/").pop()!)).mtimeMs).toBeLessThan(60_000);
  });
});

describe("开关：config.json autoArchiveCodexSubs，缺省关", () => {
  test("没开（缺省）：不扫描；开了：按 registry 全部 agent 的会话建 keep 去扫", async () => {
    const calls: Array<ReadonlySet<string>> = [];
    const fake = async (o: { keep: ReadonlySet<string> }) => (calls.push(o.keep), { archived: 3, bytes: 0 });
    expect(await sweepCodexSubsIfEnabled([{ sessionId: "a" }], {}, fake as never)).toBeNull();
    expect(await sweepCodexSubsIfEnabled([{ sessionId: "a" }], { autoArchiveCodexSubs: false }, fake as never)).toBeNull();
    expect(calls.length).toBe(0);
    expect(await sweepCodexSubsIfEnabled([{ sessionId: "a" }, {}, { sessionId: "m" }], { autoArchiveCodexSubs: true }, fake as never)).toBe(3);
    expect([...calls[0]]).toEqual(["a", "m"]);
  });

  test("manager codex-sub-archive：缺省关，on / off 写进 config.json", async () => {
    const state = mkdtempSync(join(base, "state-"));
    const run = async (...args: string[]) => {
      const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run"), BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9" };
      delete env.DISCORD_CHANNEL_ID;
      const proc = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), "codex-sub-archive", ...args], { env, stdout: "pipe", stderr: "pipe", cwd: state });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return JSON.parse(out.trim().split("\n").pop() || "{}");
    };
    expect(await run()).toMatchObject({ ok: true, enabled: false });
    expect(await run("on")).toMatchObject({ ok: true, enabled: true, idleDays: 7, retentionDays: 90 });
    expect(JSON.parse(readFileSync(join(state, "config.json"), "utf8")).autoArchiveCodexSubs).toBe(true);
    expect(await run("status")).toMatchObject({ ok: true, enabled: true });
    expect(await run("off")).toMatchObject({ ok: true, enabled: false });
    expect(await run("bogus")).toMatchObject({ ok: false });
  }, 30_000);
});
