/**
 * cwd 的 realpath 一个进程只真解析一次（src/lib/realpath-cache.ts）。
 *
 * 生产事故形态：launchd 起的 bridge 对 ~/Documents 下的 cwd 做 realpathSync，每次 open() 卡 5s 后 EINTR；
 * bg 活动追踪每 10s 调 3 次 → bridge 每 26s 冻 15s。测试里造不出 TCC，用假 realpath 数次数，
 * 再用「软链改指向」证明热路径（projectsSlug / Pi 会话目录）确实走了缓存、不再每次 open。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRealpathCache } from "../src/lib/realpath-cache.ts";
import { projectsSlug } from "../src/lib/jsonl-cost.ts";
import { resolveCwd } from "../src/lib/pi-session.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("makeRealpathCache", () => {
  test("打得开：同一路径只真解析一次", () => {
    let calls = 0;
    const real = makeRealpathCache((p) => { calls++; return `/private${p}`; });
    expect([real("/tmp/x"), real("/tmp/x"), real("/tmp/x")]).toEqual(["/private/tmp/x", "/private/tmp/x", "/private/tmp/x"]);
    expect(calls).toBe(1);
  });

  test("在但打不开（TCC 超时的 EINTR / EPERM）：记住按字面，不再每轮卡一次", () => {
    for (const code of ["EINTR", "EPERM", "EACCES"]) {
      let calls = 0;
      const real = makeRealpathCache(() => { calls++; throw errno(code); });
      expect([real("/Users/u/Documents/a"), real("/Users/u/Documents/a"), real("/Users/u/Documents/a")]).toEqual(Array(3).fill("/Users/u/Documents/a"));
      expect(calls).toBe(1);
    }
  });

  test("目录还没建（ENOENT / ENOTDIR）不记：建好后下次照常解开", () => {
    for (const code of ["ENOENT", "ENOTDIR"]) {
      let exists = false;
      const real = makeRealpathCache((p) => { if (!exists) throw errno(code); return `/private${p}`; });
      expect(real("/tmp/later")).toBe("/tmp/later");
      exists = true;
      expect(real("/tmp/later")).toBe("/private/tmp/later");
    }
  });
});

describe("热路径走缓存（改软链指向，结果不变 = 没有再 open）", () => {
  const setup = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "rp-cache-")));
    const [a, b, link] = ["a", "b", "link"].map((n) => join(base, n));
    mkdirSync(a);
    mkdirSync(b);
    symlinkSync(a, link);
    const repoint = () => { unlinkSync(link); symlinkSync(b, link); };
    return { base, a, b, link, repoint };
  };

  test("projectsSlug（bg 活动追踪每 10s 每 agent 调它）", () => {
    const { base, a, link, repoint } = setup();
    try {
      const first = projectsSlug(link);
      expect(first).toBe(projectsSlug(a));
      repoint();
      expect(projectsSlug(link)).toBe(first);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("Pi 会话目录的 resolveCwd", () => {
    const { base, a, link, repoint } = setup();
    try {
      expect(resolveCwd(link)).toBe(a);
      repoint();
      expect(resolveCwd(link)).toBe(a);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
