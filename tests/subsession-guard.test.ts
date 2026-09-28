/**
 * bridge/subsession-guard.ts：收编接口对 Codex 子会话的二次确认闸——没带 confirmSubSession 回 409 + 归属与人话，
 * 带了放行；非 Codex、不是子会话、查归属出错都放行（闸是防误操作，不是权限边界）。
 */
import { describe, expect, test } from "bun:test";
import { refuseUnconfirmedSubSession } from "../src/bridge/subsession-guard.js";

const sub = { parentId: "019a-parent", kind: "guardian_review" };
const lookup = async (id: string) => (id === "kid" ? sub : null);

describe("refuseUnconfirmedSubSession", () => {
  test("Codex 子会话、没确认 → 409，带归属，错误信息是人话", async () => {
    const r = await refuseUnconfirmedSubSession({}, "kid", "codex", lookup);
    expect(r?.status).toBe(409);
    const j = (await r!.json()) as { ok: boolean; subSession: unknown; error: string };
    expect(j.ok).toBe(false);
    expect(j.subSession).toEqual(sub);
    expect(j.error).toContain("自动审查线程");
    expect(j.error).toContain("确认");
  });

  test("带 confirmSubSession:true → 放行；只认严格的 true", async () => {
    expect(await refuseUnconfirmedSubSession({ confirmSubSession: true }, "kid", "codex", lookup)).toBeNull();
    expect((await refuseUnconfirmedSubSession({ confirmSubSession: "true" }, "kid", "codex", lookup))?.status).toBe(409);
  });

  test("主会话 / 非 Codex / 查归属出错 → 放行", async () => {
    expect(await refuseUnconfirmedSubSession({}, "main", "codex", lookup)).toBeNull();
    expect(await refuseUnconfirmedSubSession({}, "kid", "claude-code", lookup)).toBeNull();
    expect(await refuseUnconfirmedSubSession(null, "kid", "codex", async () => { throw new Error("EIO"); })).toBeNull();
  });

  test("subagent 的文案写子会话", async () => {
    const r = await refuseUnconfirmedSubSession({}, "kid", "codex", async () => ({ parentId: "p", kind: "subagent", nickname: "Popper" }));
    expect(((await r!.json()) as { error: string }).error).toContain("子会话");
  });
});
