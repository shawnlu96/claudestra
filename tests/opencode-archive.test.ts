/**
 * OpenCode 会话退役（/clear 换代、kill）后仍在 agent 的历史列表里、可读（审查 P1-A）：
 * agentRuntime 曾把 opencode 当 Claude Code，归档去 ~/.claude/projects 找源文件、静默失败，旧会话从网页历史里消失。
 * 假 opencode（OPENCODE_BIN）按夹具吐导出 JSON；状态目录由 tests/preload.ts 隔离。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeMirrorPath } from "../src/lib/opencode-session.ts";
import { agentRuntime } from "../src/lib/registry.ts";
import { ARCHIVE_ROOT } from "../src/lib/session-archive.ts";
import { listAgentSessions, readSessionHistory } from "../src/lib/session-history.ts";
import { loadRegistry, saveRegistry } from "../src/manager/core.ts";
import { cmdSetSession } from "../src/manager/set-session.ts";
import { realOpsDeps } from "../src/manager/ops-deps.ts";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/opencode-acp/export.json"), "utf8"));
const FIXTURE_SID = FIXTURE.info.id as string;
// 真会话的首条用户消息带宿主前言，远超 512 字节：归档副本靠首行认运行时，首行读不全就会被当成 CC、一条都解析不出
const PREFACE = "你是 OpenCode agent。".repeat(200);
const firstText = FIXTURE.messages[0].parts.find((p: { type: string }) => p.type === "text");
firstText.text = `${PREFACE}\n\nrun ls with bash`;

const saved: Record<string, string | undefined> = {};
const cwd = mkdtempSync(join(tmpdir(), "oc-arch-cwd-"));

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "oc-arch-bin-"));
  const dataHome = join(dir, "data");
  mkdirSync(join(dataHome, "opencode"), { recursive: true });
  writeFileSync(join(dataHome, "opencode", "opencode.db"), "");
  const exportFile = join(dir, "export.json");
  writeFileSync(exportFile, JSON.stringify(FIXTURE));
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = export ] || exit 1\nsed "s/${FIXTURE_SID}/$2/g" "${exportFile}"\n`);
  chmodSync(bin, 0o755);
  for (const [k, v] of Object.entries({ OPENCODE_BIN: bin, XDG_DATA_HOME: dataHome })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function register(name: string, sessionId: string) {
  const reg = await loadRegistry();
  reg.agents[name] = { name, runtime: "opencode", transport: "acp", cwd, sessionId, channelId: "1", status: "active" } as never;
  await saveRegistry(reg);
}

/** 镜像还在时列表按 live 给（同 CC：源不小于归档就读源）；镜像没了（清掉 / 导不出）仍从归档列出、可读 */
async function expectArchivedAndReadable(name: string, sessionId: string, currentSessionId?: string) {
  const archived = join(ARCHIVE_ROOT, name, `${sessionId}.jsonl`);
  expect(existsSync(archived)).toBe(true);
  expect((await listAgentSessions(name, { cwd, currentSessionId, runtime: "opencode" })).some((s) => s.sessionId === sessionId)).toBe(true);
  rmSync(opencodeMirrorPath(sessionId));
  const old = (await listAgentSessions(name, { cwd, currentSessionId, runtime: "opencode" })).find((s) => s.sessionId === sessionId);
  expect(old).toMatchObject({ source: "archive", path: archived });
  const page = await readSessionHistory(archived);
  expect(page.messages.length).toBeGreaterThan(0);
  expect(JSON.stringify(page.messages)).toContain("run ls with bash");
}

describe("OpenCode 会话归档进历史", () => {
  test("agentRuntime 认 opencode", () => {
    expect(agentRuntime({ runtime: "opencode" })).toBe("opencode");
    expect(agentRuntime({ runtime: "nope" })).toBe("claude-code");
  });

  test("/clear 换代：旧会话进归档、列为 archive、可读", async () => {
    const name = "agent-oc-clear";
    await register(name, "ses_ocClearOld1");
    const r = await cmdSetSession([name, "ses_ocClearNew1", "--expected", "ses_ocClearOld1"]);
    expect(r).toMatchObject({ ok: true, previousSessionId: "ses_ocClearOld1" });
    await expectArchivedAndReadable(name, "ses_ocClearOld1", "ses_ocClearNew1");
  });

  test("kill 退役：当前会话进归档、可读", async () => {
    const name = "agent-oc-kill";
    await register(name, "ses_ocKillOnly1");
    const info = (await loadRegistry()).agents[name];
    await realOpsDeps.archive(name, info);
    await expectArchivedAndReadable(name, "ses_ocKillOnly1");
  });
});
