import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appCodexBin, findCodexBin } from "../src/lib/codex.ts";

const dirs: string[] = [];
const resources = () => {
  const d = mkdtempSync(join(tmpdir(), "codex-bin-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

test("新布局：按 codex-cli/codex-package.json 的 entrypoint 找入口", () => {
  const r = resources();
  mkdirSync(join(r, "codex-cli", "bin"), { recursive: true });
  writeFileSync(join(r, "codex-cli", "codex-package.json"), JSON.stringify({ entrypoint: "bin/codex" }));
  writeFileSync(join(r, "codex-cli", "bin", "codex"), "#!/bin/sh\n");
  expect(appCodexBin(r)).toBe(join(r, "codex-cli", "bin", "codex"));
});

test("旧布局 Resources/codex 照认；清单坏了或入口不存在时也退回旧路径", () => {
  const r = resources();
  writeFileSync(join(r, "codex"), "#!/bin/sh\n");
  expect(appCodexBin(r)).toBe(join(r, "codex"));
  mkdirSync(join(r, "codex-cli"));
  writeFileSync(join(r, "codex-cli", "codex-package.json"), "{坏的");
  expect(appCodexBin(r)).toBe(join(r, "codex"));
  writeFileSync(join(r, "codex-cli", "codex-package.json"), JSON.stringify({ entrypoint: "bin/missing" }));
  expect(appCodexBin(r)).toBe(join(r, "codex"));
});

test("两种布局都没有 → null", () => {
  expect(appCodexBin(resources())).toBeNull();
});

test("CODEX_BIN 指向存在的文件时优先于 App 自带的", () => {
  const r = resources();
  const bin = join(r, "my-codex");
  writeFileSync(bin, "#!/bin/sh\n");
  const prev = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  try {
    expect(findCodexBin()).toBe(bin);
  } finally {
    if (prev === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prev;
  }
});

test("entrypoint 越界（空串 / 绝对路径 / ../ / 根外符号链接 / 目录）→ 不认新布局，退旧路径或 null", () => {
  const r = resources();
  const cli = join(r, "codex-cli");
  mkdirSync(join(cli, "bin"), { recursive: true });
  const outside = join(r, "outside");
  writeFileSync(outside, "#!/bin/sh\n");
  symlinkSync(outside, join(cli, "bin", "codex-link"));
  const bad = ["", outside, "../outside", "bin/codex-link", "bin", 42];
  const check = (want: string | null) => {
    for (const entrypoint of bad) {
      writeFileSync(join(cli, "codex-package.json"), JSON.stringify({ entrypoint }));
      expect(appCodexBin(r)).toBe(want);
    }
  };
  check(null);
  writeFileSync(join(r, "codex"), "#!/bin/sh\n");
  check(join(r, "codex"));
});

test("根内符号链接照认，返回未解析的入口路径", () => {
  const r = resources();
  const cli = join(r, "codex-cli");
  mkdirSync(join(cli, "bin"), { recursive: true });
  writeFileSync(join(cli, "real-codex"), "#!/bin/sh\n");
  symlinkSync(join(cli, "real-codex"), join(cli, "bin", "codex"));
  writeFileSync(join(cli, "codex-package.json"), JSON.stringify({ entrypoint: "bin/codex" }));
  expect(appCodexBin(r)).toBe(join(cli, "bin", "codex"));
});

test("复现 opr2-parent-symlink-reentry：../x 经根外链接绕回根内也不认", () => {
  const r = resources();
  const cli = join(r, "codex-cli");
  mkdirSync(join(cli, "bin"), { recursive: true });
  writeFileSync(join(cli, "bin", "codex"), "#!/bin/sh\n");
  symlinkSync(join(cli, "bin", "codex"), join(r, "x"));
  writeFileSync(join(cli, "codex-package.json"), JSON.stringify({ entrypoint: "../x" }));
  expect(appCodexBin(r)).toBeNull();
  writeFileSync(join(r, "codex"), "#!/bin/sh\n");
  expect(appCodexBin(r)).toBe(join(r, "codex"));
});
