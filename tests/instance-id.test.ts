import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { instanceIdSync, isInstanceId } from "../src/lib/instance-id";

const fresh = () => mkdtempSync(join(tmpdir(), "iid-"));

describe("instanceIdSync", () => {
  test("首次生成：24 位 hex、落盘、0600", () => {
    const dir = fresh();
    const id = instanceIdSync(dir);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    const path = join(dir, "instance-id");
    expect(readFileSync(path, "utf8").trim()).toBe(id);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("目录不存在也能建出来", () => {
    const dir = join(fresh(), "nested", "state");
    expect(instanceIdSync(dir)).toMatch(/^[0-9a-f]{24}$/);
    expect(readFileSync(join(dir, "instance-id"), "utf8").trim()).toBe(instanceIdSync(dir));
  });

  test("已有的 id 原样沿用（别的进程先生成的）", () => {
    const dir = fresh();
    writeFileSync(join(dir, "instance-id"), "abcdef0123456789abcdef01\n");
    expect(instanceIdSync(dir)).toBe("abcdef0123456789abcdef01");
  });

  test("文件内容被改坏 → 换成新的合法 id 并落盘", () => {
    const dir = fresh();
    writeFileSync(join(dir, "instance-id"), "not a valid id!!\n");
    const id = instanceIdSync(dir);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(readFileSync(join(dir, "instance-id"), "utf8").trim()).toBe(id);
  });

  test("同一目录多次调用结果稳定", () => {
    const dir = fresh();
    expect(instanceIdSync(dir)).toBe(instanceIdSync(dir));
  });
});

describe("isInstanceId", () => {
  test("字母数字下划线连字符、≤64", () => {
    expect(isInstanceId("abc_DEF-123")).toBe(true);
    expect(isInstanceId("a".repeat(64))).toBe(true);
    expect(isInstanceId("a".repeat(65))).toBe(false);
    expect(isInstanceId("")).toBe(false);
    expect(isInstanceId("has space")).toBe(false);
    expect(isInstanceId("a.b")).toBe(false);
    expect(isInstanceId(42)).toBe(false);
    expect(isInstanceId(undefined)).toBe(false);
  });
});
