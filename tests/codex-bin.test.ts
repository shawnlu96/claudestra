import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
