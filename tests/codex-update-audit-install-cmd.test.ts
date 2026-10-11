/**
 * hardening-CODEXUP1：升级命令绑定安装前缀、安装后复核（src/lib/codex-update-install.ts）与探测给出的前缀（codex-version.ts）。纯函数，全 fake。
 */
import { describe, expect, test } from "bun:test";
import { codexInstallCommand, CodexInstallMismatch, trustedNpmFor, verifyCodexInstall } from "../src/lib/codex-update-install";
import { npmCodexPrefix } from "../src/lib/codex-version";

const A = "/fake/a/.nvm/versions/node/v22";
const B = "/fake/b/homebrew";

describe("npmCodexPrefix", () => {
  test("npm 全局包目录 → 前缀；非 npm → undefined", () => {
    expect(npmCodexPrefix(`${A}/lib/node_modules/@openai/codex/bin/codex.js`)).toBe(A);
    expect(npmCodexPrefix(`${A}/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`)).toBe(A);
    expect(npmCodexPrefix("/fake/Caskroom/codex/0.158.0/codex-aarch64-apple-darwin")).toBeUndefined();
    expect(npmCodexPrefix(undefined)).toBeUndefined();
  });
});

describe("trustedNpmFor / codexInstallCommand", () => {
  test("[验收线 1] 前缀自带 npm 优先，不用 PATH 上的另一个", () => {
    const n = trustedNpmFor(A, (p) => p === `${A}/bin/npm`, () => ({ npm: `${B}/bin/npm`, binDir: `${B}/bin` }));
    expect(n).toEqual({ npm: `${A}/bin/npm`, binDir: `${A}/bin` });
    const c = codexInstallCommand({ version: "0.1.0", npm: true, prefix: A }, "0.2.0", () => n);
    expect(c).toMatchObject({ display: "npm install -g @openai/codex@0.2.0" });
    if ("command" in c) {
      expect(c.command).toBe(`PATH=${A}/bin:"$PATH" ${A}/bin/npm install -g --prefix ${A} @openai/codex@0.2.0`);
      expect(c.command).not.toContain(B);
    }
  });
  test("前缀没自带 npm：退到 canonical；都没有：报错不给命令", () => {
    expect(trustedNpmFor(A, () => false, () => ({ npm: `${B}/bin/npm`, binDir: `${B}/bin` }))?.npm).toBe(`${B}/bin/npm`);
    expect(codexInstallCommand({ npm: true, prefix: A }, "0.2.0", () => null)).toHaveProperty("error");
  });
  test("带空格的前缀会被引起来", () => {
    const c = codexInstallCommand({ npm: true, prefix: "/fake/my dir" }, "0.2.0", (p) => ({ npm: `${p}/bin/npm`, binDir: `${p}/bin` }));
    expect("command" in c && c.command).toContain(`--prefix '/fake/my dir'`);
  });
  test("没有安装身份（注入的旧形状）：照旧裸命令", () => {
    expect(codexInstallCommand({ npm: true, version: "0.1.0" }, "0.2.0")).toEqual({ command: "npm install -g @openai/codex@0.2.0", display: "npm install -g @openai/codex@0.2.0" });
  });
});

describe("verifyCodexInstall", () => {
  const before = { version: "0.1.0", npm: true, prefix: A };
  test("前缀不变且到目标版本：过", async () => {
    await verifyCodexInstall(before, "0.2.0", async () => ({ version: "0.2.0", npm: true, prefix: A }));
  });
  test("[验收线 1] 版本没变 / 换了前缀 / 探不出 / 探测抛错：抛 CodexInstallMismatch，文案不带路径", async () => {
    const cases = [
      async () => ({ version: "0.1.0", npm: true, prefix: A }),
      async () => ({ version: "0.2.0", npm: true, prefix: B }),
      async () => ({ version: "0.2.0", npm: false }),
      async () => null,
      async () => { throw new Error("boom"); },
    ];
    for (const probe of cases) {
      const e = await verifyCodexInstall(before, "0.2.0", probe).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(CodexInstallMismatch);
      expect(String(e.message)).not.toContain("/fake");
    }
  });
});
