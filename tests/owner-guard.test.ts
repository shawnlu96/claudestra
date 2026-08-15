/**
 * v2.19.0 认主守卫单测。
 *
 * 2026-08-15 事故：热备 MacBook 上的 launchd 自启 + rsync 过来的 registry
 * = 双响（往主机频道播假告警 + 拉起 14 个重复 agent）。`failover.sh` 的防双响
 * 检查只拦手动接管，开机自启从后门绕过去了。这里锁住代码侧的判定。
 *
 * 两条相反的失败模式都要防：
 *  - 放行了不该放行的（备机当主）→ 双响；
 *  - 拦住了不该拦的（主机改了 hostname 把自己锁在门外）→ 比双响更糟，整套服务起不来。
 */

import { describe, test, expect } from "bun:test";
import { ownerVerdict, type OwnerMarker } from "../src/lib/owner-guard.js";

const MINI: OwnerMarker = { uuid: "662123B6-UUID-MINI", host: "macmini.local", at: "2026-08-15T00:00:00Z" };
const selfMini = { uuid: "662123B6-UUID-MINI", host: "macmini.local" };
const selfBook = { uuid: "AAAAAAAA-UUID-BOOK", host: "ShawndeMacBook-Pro.local" };

describe("ownerVerdict", () => {
  test("没有标记 = 全新安装 → 放行并登记本机", () => {
    expect(ownerVerdict(null, selfMini, false)).toEqual({ ok: true, reason: "first-run" });
  });

  test("标记就是本机 → 放行", () => {
    expect(ownerVerdict(MINI, selfMini, false)).toEqual({ ok: true, reason: "match" });
  });

  test("另一台机器（备机开机自启）→ 拒绝，这正是事故场景", () => {
    const v = ownerVerdict(MINI, selfBook, false);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.owner.host).toBe("macmini.local");
  });

  test("带 CLAUDESTRA_TAKEOVER → 放行（failover.sh 的合法接管）", () => {
    expect(ownerVerdict(MINI, selfBook, true)).toEqual({ ok: true, reason: "takeover" });
  });

  test("主机改了 hostname 但 UUID 不变 → 仍放行（别把自己锁在门外）", () => {
    const renamed = { uuid: MINI.uuid, host: "mac-mini-jp.local" };
    expect(ownerVerdict(MINI, renamed, false)).toEqual({ ok: true, reason: "match" });
  });

  test("取不到 UUID 的环境退回 hostname 比对：同名放行", () => {
    const noUuidMarker: OwnerMarker = { uuid: "", host: "macmini.local", at: "x" };
    expect(ownerVerdict(noUuidMarker, { uuid: "", host: "macmini.local" }, false)).toEqual({
      ok: true,
      reason: "match",
    });
  });

  test("取不到 UUID 且 hostname 不同 → 拒绝", () => {
    const noUuidMarker: OwnerMarker = { uuid: "", host: "macmini.local", at: "x" };
    const v = ownerVerdict(noUuidMarker, { uuid: "", host: "ShawndeMacBook-Pro.local" }, false);
    expect(v.ok).toBe(false);
  });

  test("标记有 UUID、本机取不到 UUID、hostname 也不同 → 拒绝（宁可拦住备机）", () => {
    const v = ownerVerdict(MINI, { uuid: "", host: "ShawndeMacBook-Pro.local" }, false);
    expect(v.ok).toBe(false);
  });

  test("标记有 UUID、本机取不到 UUID、但 hostname 相同 → 放行", () => {
    expect(ownerVerdict(MINI, { uuid: "", host: "macmini.local" }, false)).toEqual({
      ok: true,
      reason: "match",
    });
  });
});
