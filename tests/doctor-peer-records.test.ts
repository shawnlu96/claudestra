/** doctor「peer 记录核对」（lib/doctor-peer-records.ts）：纯函数，不读文件 */
import { describe, expect, test } from "bun:test";
import { peerRecordChecks, peerRecordIssues, peerRecordSummary } from "../src/lib/doctor-peer-records.js";
import type { HttpPeer } from "../src/lib/peers.js";
import type { PinnedPeerKey } from "../src/lib/peer-keys.js";

const AT = "2026-09-01T00:00:00.000Z", LATER = "2026-09-10T00:00:00.000Z";
const FA = "aaaa-aaaa-aaaa-aaaa", FB = "bbbb-bbbb-bbbb-bbbb";
const pin = (fingerprint: string, result: string, pinnedAt = LATER): PinnedPeerKey =>
  ({ publicKey: "K".repeat(43), fingerprint, pinnedAt, lastCheck: { at: LATER, result } } as PinnedPeerKey);
const issuesOf = (recs: HttpPeer[], pins: Record<string, PinnedPeerKey> = {}) => peerRecordIssues(recs, pins).map((i) => `${i.name}:${i.issue}`);

describe("peer 记录核对", () => {
  test("干净的记录不报", () => {
    expect(issuesOf([{ name: "ok", fp: FA, addedAt: AT }], { ok: pin(FA, "ok") })).toEqual([]);
    expect(peerRecordChecks([])).toEqual([]);
  });
  test("有期望指纹但上一次验签不是 ok；unsigned 点明是老版本", () => {
    expect(issuesOf([{ name: "he", fp: FA, addedAt: AT }], { he: pin(FA, "unsigned") })[0]).toContain("老版本");
    expect(issuesOf([{ name: "he", fp: FA, addedAt: AT }], { he: pin(FA, "stale") })[0]).toContain("stale");
  });
  test("fp 格式不对、relay 地址指纹不一致、地址带路径前缀、钉住指纹和记录不同、钉住早于记录", () => {
    const all = issuesOf([
      { name: "a", fp: "zz", addedAt: AT },
      { name: "b", fp: FA, baseUrl: `relay://${FB}`, addedAt: AT },
      { name: "c", baseUrl: "https://x.example/claudestra", addedAt: AT },
      { name: "d", fp: FA, addedAt: AT },
      { name: "e", addedAt: LATER },
    ], { d: pin(FB, "ok"), e: pin(FA, "ok", AT) }).join("\n");
    for (const want of ["a:fp 格式不对", "b:fp 和 relay://", "c:对方地址带路径前缀 /claudestra", "d:记录的指纹和钉住的钥匙不是同一把", "e:钉住的钥匙早于这条记录建立"]) expect(all).toContain(want);
  });
  test("同一个实例 id 多条记录；停用的不算", () => {
    const recs: HttpPeer[] = [
      { name: "v", instanceId: "i1", fp: FA, addedAt: AT }, { name: "v-2", instanceId: "i1", fp: FB, addedAt: AT },
      { name: "v-3", instanceId: "i1", addedAt: AT, disabled: true },
    ];
    expect(issuesOf(recs)).toEqual([expect.stringMatching(/^v、v-2:同一个实例 id 有多条记录/)]);
  });
  test("汇总行不带指纹 / 公钥，只说来源和结果", () => {
    const line = peerRecordSummary({ name: "he", fp: FA, publicKey: "K".repeat(43), addedAt: AT }, pin(FA, "ok"));
    expect(line).toBe("he | 期望指纹：记录的 fp，记了完整公钥 | 上一次验签：ok");
    expect(line).not.toContain(FA);
    expect(peerRecordSummary({ name: "old", addedAt: AT }, undefined)).toContain("老 peer");
  });
});
