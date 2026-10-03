/**
 * Pi 能力快照（两条传输共用的写入器）。
 * 关键：piVersion 必须如实写进去 —— 网页那条「本会话还在 X，重启后生效」横幅读的就是它
 * （src/lib/update-hints.ts）；ACP 不写快照时，重启后横幅永远不消失（owner 2026-10-02 实报）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePiEnvSnapshot } from "../src/lib/pi-env-snapshot.js";

const api = {
  getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "codemode" }],
  getActiveTools: () => ["read", "bash", "codemode"],
  getCommands: () => [{ name: "compact" }, { name: "reload" }],
  getThinkingLevel: () => "max",
};

describe("writePiEnvSnapshot", () => {
  test("字段齐全、名字排序、piVersion 如实（横幅就靠它）", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-snap-"));
    writePiEnvSnapshot({
      pi: api, agent: "agent-x", sessionId: "sid-1", piVersion: "1.0.0", stateDir: dir,
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    const d = JSON.parse(readFileSync(join(dir, "pi-env", "agent-x.json"), "utf8"));
    expect(d.piVersion).toBe("1.0.0");
    expect(d.activeTools).toEqual(["bash", "codemode", "read"]);
    expect(d.tools).toEqual(["bash", "codemode", "read"]);
    expect(d.commandCount).toBe(2);
    expect(d.thinking).toBe("max");
    expect(d.sessionId).toBe("sid-1");
    expect(d.at).toBe("2026-10-02T00:00:00.000Z");
  });

  test("agent 名为空 ⇒ 什么都不写（不落 .json 这种垃圾）", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-snap-"));
    writePiEnvSnapshot({ pi: api, agent: "  ", piVersion: "1.0.0", stateDir: dir });
    expect(existsSync(join(dir, "pi-env"))).toBe(false);
  });

  test("查询接口缺失也不炸（老版本 Pi / 测试替身）", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-snap-"));
    writePiEnvSnapshot({ pi: {}, agent: "agent-y", stateDir: dir });
    const d = JSON.parse(readFileSync(join(dir, "pi-env", "agent-y.json"), "utf8"));
    expect(d.toolCount).toBe(0);
    expect(d.activeTools).toEqual([]);
    expect(d.piVersion).toBeUndefined();
  });
});
