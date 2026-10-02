/**
 * i28-CLP：收单子进程判 Claude 不可用时打在 stderr 的那行原因，以前 bridge 只在子进程失败时才读 stderr，成功时整段丢掉，出借方日志里看不到。
 * runManagerProcess 的可选 onStderr 成功时也把 stderr 交给调用方；bridge 收单路由（local-api/lend-inbox.ts）用 relayInboxStderr 把尾行转进自己的日志。
 */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayInboxStderr } from "../src/bridge/local-api/lend-inbox.ts";
import { runManagerProcess } from "../src/lib/run-manager.ts";

const dir = mkdtempSync(join(tmpdir(), "lend-inbox-stderr-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let stderr: ReturnType<typeof spyOn>;
beforeEach(() => { stderr = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => stderr.mockRestore());

test("onStderr：子进程成功（stdout 是 JSON）时也拿到完整 stderr，结果照旧按 stdout", async () => {
  const script = join(dir, "inbox-ok.ts");
  writeFileSync(script, 'console.error("[lend] Claude 位暂不可用（报 0 位）：本机 Claude Code 没登录"); console.log(JSON.stringify({ ok: true, accepted: [], refused: [] }));');
  const seen: string[] = [];
  const r = await runManagerProcess(["lend"], { bunPath: process.execPath, managerPath: script, timeoutMs: 20_000, onStderr: (e) => void seen.push(e) });
  expect(r).toEqual({ ok: true, accepted: [], refused: [] });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("本机 Claude Code 没登录");
});

test("不传 onStderr 的调用方行为不变", async () => {
  const script = join(dir, "plain.ts");
  writeFileSync(script, 'console.error("noise"); console.log(JSON.stringify({ ok: true }));');
  expect(await runManagerProcess(["list"], { bunPath: process.execPath, managerPath: script, timeoutMs: 20_000 })).toEqual({ ok: true });
});

test("relayInboxStderr：有内容就把尾行带前缀打进 bridge 日志，空的不打", () => {
  relayInboxStderr("\n\n");
  expect(stderr).not.toHaveBeenCalled();
  relayInboxStderr("a\nb\n[lend] Claude 位暂不可用（报 0 位）：核对本机 Claude 登录超时（8 秒）\n");
  expect(stderr.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(["[lend inbox] a | b | [lend] Claude 位暂不可用（报 0 位）：核对本机 Claude 登录超时（8 秒）"]);
});
