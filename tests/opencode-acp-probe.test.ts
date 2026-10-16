/** OCR-1B：OpenCode acp 探针的脱敏函数，以及它产出的夹具（tests/fixtures/opencode-acp/）合不合规。结论见 docs/runtimes/opencode-acp.md。 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { permissionCard } from "../src/lib/acp/permissions.ts";
import { checkInitialize } from "../src/lib/acp/protocol.ts";
import { sanitize } from "../scripts/opencode-acp-probe.ts";

const DIR = join(import.meta.dir, "fixtures/opencode-acp");
const frames = (name: string) => readFileSync(join(DIR, name), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("sanitize", () => {
  test("长路径先换，短路径不会把长路径切成半截", () => {
    const out = sanitize("/a/b/c/x and /a/b/y", [["/a/b", "<home>"], ["/a/b/c", "<tmp>"]]);
    expect(out).toBe("<tmp>/x and <home>/y");
  });
  test("token / key 形状的值整段打码", () => {
    expect(sanitize('{"apiKey":"sk-123","token":"t","other":"v"}', [])).toBe('{"apiKey":"<redacted>","token":"<redacted>","other":"v"}');
  });
  test("值里有转义引号：整值打码，后半段不漏、输出仍是合法 JSON", () => {
    const out = sanitize(JSON.stringify({ token: 'ab"cd-SECRET-TAIL', other: "v" }), []);
    expect(out).not.toContain("SECRET-TAIL");
    expect(JSON.parse(out)).toEqual({ token: "<redacted>", other: "v" });
  });
  test("字段值是一段字符串化的 JSON（嵌套）：里面的敏感字段也打码，外层仍是合法 JSON", () => {
    const inner = JSON.stringify({ apiKey: "sk-NESTED-SECRET", model: "m" });
    const out = sanitize(JSON.stringify({ msg: { params: { raw: inner } } }), []);
    expect(out).not.toContain("NESTED-SECRET");
    expect(JSON.parse(JSON.parse(out).msg.params.raw)).toEqual({ apiKey: "<redacted>", model: "m" });
  });
  test("不是 JSON 的行退回文本打码，也认转义引号", () => {
    expect(sanitize('log: "token":"ab\\"cd-TAIL" end', [])).toBe('log: "token":"<redacted>" end');
  });
});

describe("夹具", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));

  test("验收要的四类都在", () => {
    for (const f of ["initialize.jsonl", "session-new.jsonl", "prompt-tool-call.jsonl", "cancel.jsonl"]) expect(files).toContain(f);
  });

  test("每行都是 {t, dir, msg}，没有本机路径", () => {
    for (const f of files) {
      const raw = readFileSync(join(DIR, f), "utf8");
      expect(raw).not.toMatch(/\/Users\/|\/private\/tmp\/|claude-\d+/);
      for (const fr of frames(f)) {
        expect(typeof fr.t).toBe("number");
        expect(["host→agent", "agent→host"]).toContain(fr.dir);
        expect(fr.msg.jsonrpc).toBe("2.0");
      }
    }
  });

  test("initialize 回包过宿主的兼容判定（resume / fork 都有）", () => {
    const res = frames("initialize.jsonl").find((fr) => fr.dir === "agent→host")!.msg.result;
    expect(checkInitialize(res)).toMatchObject({ ok: true, resume: true, fork: true, agentInfo: { name: "OpenCode" } });
  });

  test("权限请求宿主不改就能出卡", () => {
    const req = frames("permission.jsonl").find((fr) => fr.msg.method === "session/request_permission")!.msg.params;
    const card = permissionCard(req, "OpenCode");
    expect(card?.options.map((o) => o.style)).toEqual(["success", "success", "danger"]);
  });

  test("cancel 后 prompt 以 cancelled 收尾", () => {
    const stops = frames("cancel.jsonl").map((fr) => fr.msg.result?.stopReason).filter(Boolean);
    expect(stops[0]).toBe("cancelled");
  });
});
