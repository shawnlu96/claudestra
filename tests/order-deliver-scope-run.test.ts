import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeRunIn } from "../src/lib/order-deliver-scope-git.js";

let dir = "";
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "scope-run-"))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("success resolves stdout of a real command run in dir", async () => {
  expect(await scopeRunIn(dir)("pwd", [])).toBe(`${dir}\n`);
});

test("non-zero exit rejects with command name, first arg and exit code", async () => {
  const err = await scopeRunIn(dir)("sh", ["-c", "echo boom >&2; exit 3"]).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("sh -c 失败");
  expect((err as Error).message).toContain("exit 3");
  expect((err as Error).message).toContain("boom");
});

test("tiny timeout rejects with 超时", async () => {
  const err = await scopeRunIn(dir, 50)("sleep", ["5"]).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("sleep 5 超时");
});
