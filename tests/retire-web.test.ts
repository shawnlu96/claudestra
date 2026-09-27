/**
 * `claudestra retire-web` 的前置判定（manager/retire-web.ts）：设计 §10 的顺序是「先验证新模式，再停旧 Next」，
 * 所以四个前置缺任何一个都不许卸，且要把缺的都点名（不是只报第一个）。
 */
import { describe, expect, test } from "bun:test";
import { isWebBackup, retireWebPlan, type RetireFacts } from "../src/manager/retire-web.js";

const ready: RetireFacts = { staticDir: "/r/web/out", staticIndex: true, bridgeServing: true, backups: ["web-2026-09-27T10-00-00-000Z.tgz"], plistExists: true };

describe("retireWebPlan", () => {
  test("四个前置齐了 → 放行，带上 plist 在不在（不在 = 已退场过，只报不动）", () => {
    expect(retireWebPlan(ready)).toEqual({ ok: true, plistExists: true });
    expect(retireWebPlan({ ...ready, plistExists: false })).toEqual({ ok: true, plistExists: false });
  });

  test("没配 BRIDGE_STATIC_DIR → 拒，且不再抱怨 index.html（没目录谈不上文件）", () => {
    const p = retireWebPlan({ ...ready, staticDir: "", staticIndex: false });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.missing).toHaveLength(1);
    expect(p.missing[0]).toContain("BRIDGE_STATIC_DIR");
  });

  test("配了目录但没有 index.html → 拒，指向 npm run build", () => {
    const p = retireWebPlan({ ...ready, staticIndex: false });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.missing[0]).toContain("/r/web/out");
    expect(p.missing[0]).toContain("npm run build");
  });

  test("bridge 没在托管（/app-config.json 不应答）→ 拒：新模式没验证过就不能停旧的", () => {
    const p = retireWebPlan({ ...ready, bridgeServing: false });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.missing[0]).toContain("app-config.json");
  });

  test("没有 web-*.tgz 备份 → 拒：migrate-web-state 没跑过", () => {
    const p = retireWebPlan({ ...ready, backups: [] });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.missing[0]).toContain("migrate-web-state");
  });

  test("缺几个就列几个", () => {
    const p = retireWebPlan({ staticDir: "", staticIndex: false, bridgeServing: false, backups: [], plistExists: true });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.missing).toHaveLength(3);
  });
});

describe("isWebBackup", () => {
  test("只认 migrate-web-state 的 web-<时间戳>.tgz，不认别的备份或 plist 备份", () => {
    expect(isWebBackup("web-2026-09-27T10-00-00-000Z.tgz")).toBe(true);
    expect(isWebBackup("web-.tgz")).toBe(false);
    expect(isWebBackup("com.claudestra.web.plist.2026-09-27T10-00-00-000Z")).toBe(false);
    expect(isWebBackup("registry-2026.json")).toBe(false);
  });
});
