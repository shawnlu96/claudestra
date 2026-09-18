import { describe, expect, test } from "bun:test";
import { dequarantineByReplace, probeClaudeVersion, resolveClaudeBinary, type Runner } from "../src/lib/claude-binary";

const REAL = "/opt/homebrew/Caskroom/claude-code@latest/2.1.274/claude";
const COPY = `${REAL}.claudestra-new`;

function fakeRunner(failOn: (cmd: string[]) => boolean = () => false) {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    return failOn(cmd) ? { ok: false, out: "", err: "boom" } : { ok: true, out: "", err: "" };
  };
  return { run, calls };
}

describe("dequarantineByReplace — master 配方", () => {
  test("顺序:cp 副本 → xattr -c 副本 → 探副本 → rm 原 → mv 回 → 探原", async () => {
    const { run, calls } = fakeRunner();
    const probed: string[] = [];
    const r = await dequarantineByReplace(REAL, run, async (b) => { probed.push(b); return true; });
    expect(r.ok).toBe(true);
    expect(r.steps).toEqual(["cp", "xattr -c", "probe copy", "rm original", "mv back", "probe original"]);
    expect(calls).toEqual([
      ["cp", "-p", REAL, COPY],
      ["xattr", "-c", COPY],
      ["rm", "-f", REAL],
      ["mv", COPY, REAL],
    ]);
    expect(probed).toEqual([COPY, REAL]);
    // 绝不在原路径上做 xattr -d(实测无效,vnode 已被钉住)
    expect(calls.some((c) => c[0] === "xattr" && c.includes(REAL))).toBe(false);
  });

  test("副本探测失败 → 清掉副本、不动原文件、报失败", async () => {
    const { run, calls } = fakeRunner();
    const r = await dequarantineByReplace(REAL, run, async () => false);
    expect(r.ok).toBe(false);
    expect(r.steps).toEqual(["cp", "xattr -c", "probe copy"]);
    expect(calls).toContainEqual(["rm", "-f", COPY]);
    expect(calls.some((c) => c[0] === "rm" && c.includes(REAL))).toBe(false);
  });

  test("cp 失败 → 立即报失败,什么都不删", async () => {
    const { run, calls } = fakeRunner((c) => c[0] === "cp");
    const r = await dequarantineByReplace(REAL, run, async () => true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cp 失败");
    expect(calls.filter((c) => c[0] === "rm")).toHaveLength(0);
  });

  test("mv 回原名失败 → 报错里带副本位置(原文件已删,别让人找不到)", async () => {
    const { run } = fakeRunner((c) => c[0] === "mv");
    const r = await dequarantineByReplace(REAL, run, async () => true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(COPY);
  });
});

describe("resolveClaudeBinary / probeClaudeVersion", () => {
  test("登录 shell 解析:两行输出 → link + real", async () => {
    const run: Runner = async () => ({ ok: true, out: "/opt/homebrew/bin/claude\n" + REAL + "\n", err: "" });
    expect(await resolveClaudeBinary(run)).toEqual({ link: "/opt/homebrew/bin/claude", real: REAL });
  });
  test("解析失败 / 输出残缺 → null", async () => {
    expect(await resolveClaudeBinary(async () => ({ ok: false, out: "", err: "" }))).toBeNull();
    expect(await resolveClaudeBinary(async () => ({ ok: true, out: "/x\n", err: "" }))).toBeNull();
  });
  test("版本号从输出里抠;超时/失败 → null", async () => {
    expect(await probeClaudeVersion(async () => ({ ok: true, out: "2.1.274 (Claude Code)", err: "" }), REAL)).toBe("2.1.274");
    expect(await probeClaudeVersion(async () => ({ ok: false, out: "", err: "" }), REAL)).toBeNull();
  });
});
