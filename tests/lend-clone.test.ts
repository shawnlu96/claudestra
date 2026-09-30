/** T94 出借单的工作副本（src/lib/lend-clone.ts）：新 clone、按完整 SHA 取、核 HEAD；用本地仓库代替 GitHub */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderDir, orderDirName, outsideLink, prepareClone, removeOrderDir, type Run } from "../src/lib/lend-clone.js";
import { runBounded } from "../src/lib/run-bounded.js";

const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: "gh-secret", BRIDGE_CONTROL_TOKEN: "ctl" };

async function sourceRepo(links: Record<string, string> = {}): Promise<{ dir: string; head: string }> {
  const dir = mkdtempSync(join(tmpdir(), "lend-src-"));
  const git = (...a: string[]) => runBounded(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, timeoutMs: 20_000 });
  await git("init", "-q");
  await git("config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(dir, "a.txt"), "1");
  for (const [at, to] of Object.entries(links)) (mkdirSync(join(dir, at, ".."), { recursive: true }), symlinkSync(to, join(dir, at)));
  await git("add", "-A");
  await git("commit", "-qm", "c1");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(dir, "a.txt"), "2");
  await git("commit", "-qam", "c2");
  return { dir, head };
}

/** 真 git，只把 origin 换成本地仓库；记下每次调用的环境 */
function localRun(src: string, seen: Record<string, string>[] = []): Run {
  return (argv, opts) => {
    seen.push(opts.env);
    const i = argv.indexOf("add");
    const mapped = argv[1] === "remote" && i > 0 ? [...argv.slice(0, i + 2), src] : argv;
    return runBounded(mapped, opts);
  };
}

describe("T94 工作副本", () => {
  test("取订单给的那个 SHA（不是分支最新），HEAD 核对一致；目录在 lend/work 下、是独立仓库", async () => {
    const { dir: src, head } = await sourceRepo();
    const root = mkdtempSync(join(tmpdir(), "lend-root-"));
    const seen: Record<string, string>[] = [];
    const r = await prepareClone({ orderId: "int_1:review", repo: "o/r", pr: 1, head }, { root, env: ENV, run: localRun(src, seen) });
    expect(r).toEqual({ ok: true, dir: orderDir("int_1:review", root) });
    const got = await runBounded(["git", "rev-parse", "HEAD", "--git-dir"], { cwd: (r as { dir: string }).dir, timeoutMs: 5000 });
    expect(got.stdout.trim().split("\n")).toEqual([head, ".git"]);
    for (const e of seen) {
      expect(e.GH_TOKEN).toBeUndefined();
      expect(e.BRIDGE_CONTROL_TOKEN).toBeUndefined();
      expect(e.GIT_TERMINAL_PROMPT).toBe("0");
    }
  });

  test("取不到这个 SHA / checkout 后 HEAD 对不上：失败（调用方按 not_started 释放）", async () => {
    const { dir: src, head } = await sourceRepo();
    const root = mkdtempSync(join(tmpdir(), "lend-root-"));
    expect(await prepareClone({ orderId: "o2", repo: "o/r", pr: null, head: "b".repeat(40) }, { root, env: ENV, run: localRun(src) }))
      .toMatchObject({ ok: false });
    const lying: Run = async (argv, opts) => argv.includes("rev-parse") ? { code: 0, stdout: "c".repeat(40), stderr: "", timedOut: false } : localRun(src)(argv, opts);
    expect(await prepareClone({ orderId: "o3", repo: "o/r", pr: null, head }, { root, env: ENV, run: lying })).toMatchObject({ ok: false, reason: expect.stringContaining("不一致") });
  });

  test("仓库坐标、head 不合格：不动磁盘直接拒", async () => {
    const root = mkdtempSync(join(tmpdir(), "lend-root-"));
    expect(await prepareClone({ orderId: "o", repo: "../x", pr: null, head: "a".repeat(40) }, { root })).toMatchObject({ ok: false });
    expect(await prepareClone({ orderId: "o", repo: "o/r", pr: null, head: "abc" }, { root })).toMatchObject({ ok: false });
    expect(existsSync(join(root, "work"))).toBe(false);
  });

  test("目录名：带冒号的 orderId 也安全，两张单不会落到同一目录", () => {
    expect(orderDirName("a:b")).not.toBe(orderDirName("a_b"));
    expect(orderDirName("../../x")).not.toContain("/");
  });

  test("对方仓库里提交了指向工作副本外面的软链（.env → 宿主文件、子目录里的 ../../ 逃逸）：不起 worker；指向里面的软链照常", async () => {
    const host = mkdtempSync(join(tmpdir(), "host-"));
    writeFileSync(join(host, ".env"), "GH_TOKEN=fake-host-gh\n");
    const root = mkdtempSync(join(tmpdir(), "lend-root-"));
    for (const [i, links] of ([{ ".env": join(host, ".env") }, { "sub/deep/.env.local": "../../../../host/.env" }] as Record<string, string>[]).entries()) {
      const { dir: src, head } = await sourceRepo(links);
      expect(await prepareClone({ orderId: `ln${i}`, repo: "o/r", pr: null, head }, { root, env: ENV, run: localRun(src) }))
        .toMatchObject({ ok: false, reason: expect.stringContaining("软链") });
    }
    const { dir: src, head } = await sourceRepo({ "docs/a.txt": "../a.txt", "b": "docs" });
    expect(await prepareClone({ orderId: "ln-ok", repo: "o/r", pr: null, head }, { root, env: ENV, run: localRun(src) })).toMatchObject({ ok: true });
    expect(outsideLink(orderDir("ln-ok", root))).toBeNull();
  });

  test("删目录只删这张单自己的：软链到别处的不删", () => {
    const root = mkdtempSync(join(tmpdir(), "lend-root-"));
    const victim = mkdtempSync(join(tmpdir(), "victim-"));
    writeFileSync(join(victim, "keep"), "x");
    mkdirSync(join(root, "work"), { recursive: true });
    symlinkSync(victim, orderDir("o9", root));
    expect(() => removeOrderDir("o9", root)).toThrow(/拒绝删除/);
    expect(existsSync(join(victim, "keep"))).toBe(true);
  });
});
