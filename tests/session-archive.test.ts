/**
 * v2.8+ 会话归档单测：快照复制 / 只在更大时覆盖 / subagents 同行 / 源缺失容错
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { agentArchiveDir, archiveSession, realpathWithin } from "../src/lib/session-archive.js";
import { listAgentSessions } from "../src/lib/session-history.js";

const SID = "11111111-2222-3333-4444-555555555555";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "archive-test-"));
  const srcDir = join(base, "projects-slug");
  mkdirSync(srcDir, { recursive: true });
  const srcPath = join(srcDir, `${SID}.jsonl`);
  writeFileSync(srcPath, '{"type":"assistant"}\n{"type":"user"}\n');
  return { base, srcPath, archiveRoot: join(base, "archive") };
}

describe("archiveSession", () => {
  test("首次归档：复制主 jsonl 到 archive/<agent>/", async () => {
    const { srcPath, archiveRoot } = setup();
    const r = await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    expect(r.ok).toBe(true);
    expect(r.archived.length).toBe(1);
    const dest = join(archiveRoot, "agent-x", `${SID}.jsonl`);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain('"assistant"');
  });

  test("重复归档：源更大才覆盖，缩水不回写", async () => {
    const { srcPath, archiveRoot } = setup();
    await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    // 源变小（不该覆盖）
    writeFileSync(srcPath, "{}\n");
    let r = await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    expect(r.archived.length).toBe(0);
    const dest = join(archiveRoot, "agent-x", `${SID}.jsonl`);
    expect(readFileSync(dest, "utf8")).toContain('"assistant"');
    // 源变大（应覆盖）
    writeFileSync(srcPath, '{"type":"assistant"}\n{"type":"user"}\n{"type":"assistant","more":1}\n');
    r = await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    expect(r.archived.length).toBe(1);
    expect(readFileSync(dest, "utf8")).toContain('"more"');
  });

  test("subagents 目录一并归档", async () => {
    const { srcPath, archiveRoot } = setup();
    const subDir = join(srcPath.replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-abc.jsonl"), '{"type":"assistant"}\n');
    const r = await archiveSession("agent-x", undefined, SID, { srcPath, archiveRoot });
    expect(r.archived.length).toBe(2);
    expect(existsSync(join(archiveRoot, "agent-x", SID, "subagents", "agent-abc.jsonl"))).toBe(true);
  });

  test("源不存在：ok:false 不抛错", async () => {
    const { archiveRoot } = setup();
    const r = await archiveSession("agent-x", undefined, "99999999-9999-9999-9999-999999999999", {
      srcPath: "/no/such/file.jsonl",
      archiveRoot,
    });
    expect(r.ok).toBe(false);
  });
});

describe("读归档先按真实路径核对根目录：符号链接绕不出去（T32 纵深防御）", () => {
  const SID2 = "66666666-7777-8888-9999-000000000000";
  function tree() {
    const base = mkdtempSync(join(tmpdir(), "archive-link-"));
    const root = join(base, "archive");
    const outside = join(base, "outside");
    mkdirSync(join(root, "agent-ok"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.jsonl"), '{"type":"user","message":{"content":"secret"}}\n');
    writeFileSync(join(root, "agent-ok", `${SID}.jsonl`), '{"type":"user"}\n');
    symlinkSync(outside, join(root, "agent-evil")); // 整个 agent 目录指到外面
    symlinkSync(join(outside, "secret.jsonl"), join(root, "agent-ok", `${SID2}.jsonl`)); // 单个会话文件指到外面
    symlinkSync(root, join(base, "root-link")); // 根自己是链接（把状态目录挪到别的盘）不该误伤
    return { base, root };
  }

  test("agent 目录是指到根外的链接 → null；真实目录、经链接到达的根都照常", () => {
    const { base, root } = tree();
    try {
      expect(agentArchiveDir("agent-evil", root)).toBeNull();
      expect(agentArchiveDir("agent-ok", root)).toBe(join(root, "agent-ok"));
      expect(agentArchiveDir("agent-ok", join(base, "root-link"))).toBe(join(base, "root-link", "agent-ok"));
      expect(agentArchiveDir("agent-new", root)).toBe(join(root, "agent-new")); // 还不存在：只做字面校验
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("listAgentSessions：链接目录整个不读，目录里指到外面的会话文件跳过", async () => {
    const { base, root } = tree();
    try {
      expect(await listAgentSessions("agent-evil", { archiveRoot: root })).toEqual([]);
      const ok = await listAgentSessions("agent-ok", { archiveRoot: root });
      expect(ok.map((x) => x.sessionId)).toEqual([SID]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("realpathWithin：悬空链接、不存在的路径都当不在根下", () => {
    const { base, root } = tree();
    try {
      symlinkSync(join(base, "gone"), join(root, "dangling"));
      expect(realpathWithin(join(root, "dangling"), root)).toBe(false);
      expect(realpathWithin(join(root, "nope"), root)).toBe(false);
      expect(realpathWithin(root, root)).toBe(false); // 根本身不算「根下」
      expect(realpathWithin(join(root, "agent-ok", `${SID}.jsonl`), root)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
