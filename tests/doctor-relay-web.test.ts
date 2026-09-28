import { describe, expect, test } from "bun:test";
import { relayWebCheck } from "../src/lib/doctor-relay-web";

const G = "手机访问";
const BASE = "relay.example.com";

describe("doctor 的「中继托管的网页」一项（relayWebCheck）", () => {
  test("中继比本机旧（T10b：中继停在 T10 之前，手机勾选不进输入框）→ warn，带两边 commit 与部署命令", () => {
    const c = relayWebCheck({ relay: "7653abe", local: "bbf0003", relayOlder: true }, BASE, G);
    expect(c).toMatchObject({ group: G, name: "中继托管的网页", status: "warn" });
    expect(c!.detail).toContain("7653abe");
    expect(c!.detail).toContain("bbf0003");
    expect(c!.fix).toContain("RELAY_WITH_WEB=1");
  });
  test("一致（长短 hash 混用也认）→ ok", () => {
    expect(relayWebCheck({ relay: "bbf0003", local: "bbf0003", relayOlder: null }, BASE, G)?.status).toBe("ok");
    expect(relayWebCheck({ relay: "bbf0003ab12", local: "bbf0003", relayOlder: null }, BASE, G)?.status).toBe("ok");
  });
  test("本机认不出中继的 commit（别的实例部署的）或中继更新 → ok，不误报", () => {
    expect(relayWebCheck({ relay: "abc1234", local: "bbf0003", relayOlder: null }, BASE, G)?.status).toBe("ok");
    expect(relayWebCheck({ relay: "abc1234", local: "bbf0003", relayOlder: false }, BASE, G)?.status).toBe("ok");
  });
  test("中继没托管前端 / 本机没托管 → 不出这一项", () => {
    expect(relayWebCheck({ relay: null, local: "bbf0003", relayOlder: null }, BASE, G)).toBeNull();
    expect(relayWebCheck({ relay: "7653abe", local: null, relayOlder: null }, BASE, G)).toBeNull();
  });
});
