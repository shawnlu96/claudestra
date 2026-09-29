import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter } from "../src/lib/acp/adapter-proc.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import { repoStubPath } from "../src/lib/acp/stub.ts";

test("ACP stub：fork 新线程、重新接上、引导轮后能继续 prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "t60-acp-fork-"));
  const stub = repoStubPath();
  if (!stub) throw new Error("缺 ACP stub");
  const logs: string[] = [];
  const proc = spawnAdapter([process.execPath, stub], {
    PATH: process.env.PATH ?? "", HOME: root, CODEX_HOME: join(root, ".codex"), CODEX_CONFIG: "{}", APP_SERVER_LOGS: root,
  }, root, (line) => logs.push(line));
  try {
    const session = new AcpSession(proc.wire, { onUpdate: () => {}, onPermission: async () => null, log: (line) => logs.push(line) });
    const caps = await session.initialize();
    expect(caps).toEqual({ resume: true, fork: true });
    const source = await session.create(root);
    expect((await session.prompt("seed")).kind).toBe("done");
    const forked = await session.fork(source, root);
    expect(forked).not.toBe(source);
    await session.attach(forked, root, caps.resume);
    expect((await session.prompt("bootstrap")).kind).toBe("done");
    expect(session.sessionId).toBe(forked);
  } finally {
    proc.stop();
    await proc.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
