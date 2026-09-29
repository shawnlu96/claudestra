/**
 * 归档用的 Codex rollout 定位（T72 r1 P1-1 / P1-2）：同一个 thread id 有多份 rollout 时只认首行 id 与 cwd 都对得上的那一份，
 * 认不准就拒；rollout 根认 CODEX_HOME。全部在临时目录里造假 rollout，不碰真实 ~/.codex。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickCodexRolloutForArchive } from "../src/lib/codex-rollout-pick.js";
import { codexSessionsRoot } from "../src/lib/codex-session.js";

const base = mkdtempSync(join(tmpdir(), "rollout-pick-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const SID = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
let n = 0;

/** 在 root 下写一份 rollout；mtime 可调（findCodexSessionPath 按 mtime 取第一个，重复 id 时新的那份会被它先拿到） */
function rollout(root: string, meta: Record<string, unknown>, opts: { day?: string; id?: string; mtime?: number } = {}): string {
  const dir = join(root, "2026", "09", opts.day ?? "30");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-2026-09-30T01-02-0${n++}-${opts.id ?? SID}.jsonl`);
  writeFileSync(p, `${JSON.stringify({ type: "session_meta", payload: meta })}\n{"type":"response_item"}\n`);
  if (opts.mtime) utimesSync(p, opts.mtime, opts.mtime);
  return p;
}

function freshRoot(): string {
  const root = join(base, `r${n++}`, "sessions");
  mkdirSync(root, { recursive: true });
  return root;
}

describe("pickCodexRolloutForArchive", () => {
  test("同 id 两份、cwd 不同：拿 registry cwd 对得上的那份，哪怕另一份更新", async () => {
    const root = freshRoot();
    const mine = rollout(root, { id: SID, cwd: "/agent/one" }, { day: "29", mtime: 1_790_000_000 });
    rollout(root, { id: SID, cwd: "/agent/two" }, { mtime: 1_790_100_000 });
    expect(await pickCodexRolloutForArchive(SID, "/agent/one", root)).toEqual({ path: mine });
  });

  test("同 id 两份、cwd 也相同：分不清，拒绝并列出两份候选", async () => {
    const root = freshRoot();
    const a = rollout(root, { id: SID, cwd: "/agent/one" });
    const b = rollout(root, { id: SID, cwd: "/agent/one" }, { day: "28" });
    const r = await pickCodexRolloutForArchive(SID, "/agent/one", root);
    expect("error" in r && r.error).toContain("分不清");
    for (const p of [a, b]) expect("error" in r && r.error).toContain(p);
  });

  test("registry 没记 cwd 又有两份：同样拒绝，不按 mtime 猜", async () => {
    const root = freshRoot();
    rollout(root, { id: SID, cwd: "/agent/one" });
    rollout(root, { id: SID, cwd: "/agent/two" });
    const r = await pickCodexRolloutForArchive(SID, undefined, root);
    expect("error" in r).toBe(true);
  });

  test("只有一份但 cwd 对不上 registry：拒绝（说明里带上它的 cwd）", async () => {
    const root = freshRoot();
    rollout(root, { id: SID, cwd: "/agent/two" });
    const r = await pickCodexRolloutForArchive(SID, "/agent/one", root);
    expect("error" in r && r.error).toContain("cwd=/agent/two");
  });

  test("文件名是这个 id、首行 id 却是别的：不认", async () => {
    const root = freshRoot();
    rollout(root, { id: "019a0000-0000-7000-8000-000000000000", cwd: "/agent/one" });
    expect("error" in (await pickCodexRolloutForArchive(SID, "/agent/one", root))).toBe(true);
  });

  test("只认完整 id：前缀相同的别的线程不算", async () => {
    const root = freshRoot();
    rollout(root, { id: "019a2b3c-4d5e-7f60-8a9b-ffffffffffff", cwd: "/agent/one" }, { id: "019a2b3c-4d5e-7f60-8a9b-ffffffffffff" });
    const r = await pickCodexRolloutForArchive(SID, "/agent/one", root);
    expect("error" in r && r.error).toContain(`${root} 下找不到 thread ${SID}`);
  });

  test("cwd 经符号链接写法不同（/tmp 与 /private/tmp 这类）也认得出是同一个目录", async () => {
    const root = freshRoot();
    const real = join(base, "real-dir");
    const link = join(base, "link-dir");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const p = rollout(root, { id: SID, cwd: real });
    expect(await pickCodexRolloutForArchive(SID, `${link}/`, root)).toEqual({ path: p });
  });
});

describe("codexSessionsRoot 认 CODEX_HOME", () => {
  test("设了 CODEX_HOME 就在它下面；没设才是 ~/.codex；显式给 home 时只按 home 算", () => {
    expect(codexSessionsRoot(undefined, { CODEX_HOME: "/x/codex" })).toBe("/x/codex/sessions");
    expect(codexSessionsRoot(undefined, { CODEX_HOME: "  " })).toMatch(/\/\.codex\/sessions$/);
    expect(codexSessionsRoot("/home/u", { CODEX_HOME: "/x/codex" })).toBe("/home/u/.codex/sessions");
  });
});
