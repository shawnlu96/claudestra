/** S2C 验收线 2：故障注入——丢响应（已提交但不回）、503、重启换 bootId、升 serviceGeneration，另加备份恢复与丢响应的迁移 / 回退查询。
 * 只用合成 fake center（tests/helpers/shared-ledger-v2-fake-center*），不读生产、不连网络。
 */
import { describe, expect, test } from "bun:test";
import { v2ObjectDigest, type V2Command } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_REVERT_REQUEST_FIXTURE } from "../src/lib/shared-ledger-contract-v2-routes-fixtures.js";
import { V2_ROUTES } from "../src/lib/shared-ledger-contract-v2-routes.js";
import { FakeCenterDropped } from "./helpers/shared-ledger-v2-fake-center.js";
import { ACTORS, code, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const { owner, member } = ACTORS;
const titleSet = (k: ReturnType<typeof kit>, title: string, extra: { requestId?: string; serviceGeneration?: number } = {}) =>
  k.command("task.set", { taskId: "task-exec", expectedRev: 1, expectedSpecRev: 1, patch: { title } }, extra);
const receiptOf = (k: ReturnType<typeof kit>, c: V2Command, actor = member) =>
  k.call(actor, "receipts", { requestId: c.requestId, operationId: null, commandDigest: v2ObjectDigest(c) }).body as { status: string; receipt: unknown };

describe("S2C 验收线 2：故障注入", () => {
  test("丢响应：中心已提交但不回；回执查询 committed，原样重发回同一回执、不重复写", () => {
    const k = kit(), c = titleSet(k, "丢了回包");
    k.center.inject({ kind: "drop", route: "commands", command: "task.set" });
    expect(() => k.post(member, c)).toThrow(FakeCenterDropped);
    expect(k.center.rows().tasks.get("task-exec")).toMatchObject({ title: "丢了回包", rev: 2 });
    const lookup = receiptOf(k, c);
    expect(lookup.status).toBe("committed");
    const seq = k.center.rows().serverSeq, replay = k.post(member, c);
    expect(replay).toEqual({ status: 200, body: lookup.receipt });
    expect(k.center.rows().serverSeq).toBe(seq);
    expect(k.center.log.map(e => e.status)).toEqual(["dropped", 200, 200]);
  });
  test("丢响应经 fetch 适配器表现为网络错误（reject），中心仍已提交", async () => {
    const k = kit(), c = titleSet(k, "fetch 丢包"), fetch = k.center.fetch(() => member);
    k.center.inject({ kind: "drop" });
    const url = `https://center.invalid${V2_ROUTES.commands.path({ teamId: "team", projectId: "project" })}`;
    await expect(fetch(url, { method: "POST", body: JSON.stringify(c) })).rejects.toThrow("fetch failed");
    expect(receiptOf(k, c).status).toBe("committed");
  });
  test("503：请求不被读也不被写，回执 unknown；故障次数用完后照常", () => {
    const k = kit(), c = titleSet(k, "503 后"), before = k.center.rows();
    k.center.inject({ kind: "unavailable", route: "commands", times: 2 });
    for (let i = 0; i < 2; i++) { const res = k.post(member, c); expect([res.status, code(res)]).toEqual([503, "unavailable"]); }
    expect(k.center.rows()).toEqual(before);
    expect(receiptOf(k, c).status).toBe("unknown");
    expect(k.post(member, c).status).toBe(200);
    expect(receiptOf(k, c).status).toBe("committed");
  });
  test("503 只打指定路由：features 照常可读", () => {
    const k = kit();
    k.center.inject({ kind: "unavailable", route: "commands" });
    expect(k.call(member, "features", { featureId: "feature-exec" }).status).toBe(200);
    expect(code(k.post(member, titleSet(k, "x")))).toBe("unavailable");
  });
  test("重启换 bootId：代际不变、行与回执都在，重放回原回执，新命令照常", () => {
    const k = kit(), c = titleSet(k, "重启前"), sent = k.post(member, c), boot = k.center.generation().bootId;
    k.center.restart();
    const gen = k.center.generation();
    expect(gen.bootId).not.toBe(boot);
    expect(gen.serviceGeneration).toBe(1);
    expect(k.post(member, c)).toEqual(sent);
    expect(receiptOf(k, c).status).toBe("committed");
    const next = k.command("task.set", { taskId: "task-exec", expectedRev: 2, expectedSpecRev: 1, patch: { title: "重启后" } });
    expect(k.post(member, next).status).toBe(200);
  });
  test("升 serviceGeneration：旧代际写 stale_generation（0 写），新代际照常；旧回执重放仍是旧代际的那张", () => {
    const k = kit(), old = titleSet(k, "旧代际"), sent = k.post(member, old);
    k.center.bumpGeneration();
    expect(k.center.generation().serviceGeneration).toBe(2);
    expect(k.post(member, old)).toEqual(sent);
    expect((sent.body as { serviceGeneration: number }).serviceGeneration).toBe(1);
    const stale = k.command("task.set", { taskId: "task-exec", expectedRev: 2, expectedSpecRev: 1, patch: { title: "x" } });
    const before = k.center.rows();
    const res = k.post(member, stale);
    expect([res.status, code(res)]).toEqual([409, "stale_generation"]);
    expect(k.center.rows()).toEqual(before);
    const fresh = k.command("task.set", { taskId: "task-exec", expectedRev: 2, expectedSpecRev: 1, patch: { title: "新代际" } }, { serviceGeneration: 2 });
    expect((k.post(member, fresh).body as { serviceGeneration: number }).serviceGeneration).toBe(2);
    expect((k.call(member, "features", { featureId: "feature-exec" }).body as { serviceGeneration: number }).serviceGeneration).toBe(2);
  });
  test("备份恢复：备份后提交的行与回执消失，回执查询 unknown，代际越过备份并记 restoredFrom", () => {
    const k = kit(), backup = k.center.backup(), c = titleSet(k, "备份后");
    k.post(member, c);
    k.center.restore(backup);
    expect(receiptOf(k, c).status).toBe("unknown");
    expect(k.center.rows().tasks.get("task-exec")).toMatchObject({ rev: 1 });
    expect(k.center.generation()).toMatchObject({ serviceGeneration: 2, restoredFrom: { serviceGeneration: 1, serverSeq: 0 } });
    expect(code(k.post(member, c))).toBe("stale_generation");
  });
  test("迁移 / 回退丢响应：已提交的批次查询 committed，没发过的批次 unknown", () => {
    const k = kit(), request = { ...V2_REVERT_REQUEST_FIXTURE, featureIds: ["feature-exec"], authorizationAskId: "ask-exec" };
    k.center.inject({ kind: "drop", route: "reverts" });
    expect(() => k.call(owner, "reverts", {}, request)).toThrow(FakeCenterDropped);
    expect(k.call(owner, "revert", { batchId: request.batchId }).body).toMatchObject({ status: "committed",
      result: { batchId: request.batchId, nextEpoch: 2 } });
    expect(k.center.feature("feature-exec")).toMatchObject({ authorityMode: "planning", epoch: 2 });
    expect(k.call(owner, "revert", { batchId: "revert-never" }).body).toMatchObject({ status: "unknown", result: null });
    expect(k.call(owner, "migration", { batchId: "batch-never" }).body).toMatchObject({ status: "unknown", result: null });
  });
  test("503 打在迁移 POST 上：0 写，查询 unknown", () => {
    const k = kit(), request = { ...V2_REVERT_REQUEST_FIXTURE, featureIds: ["feature-exec"], authorizationAskId: "ask-exec" };
    k.center.inject({ kind: "unavailable", route: "reverts" });
    expect(code(k.call(owner, "reverts", {}, request))).toBe("unavailable");
    expect(k.call(owner, "revert", { batchId: request.batchId }).body).toMatchObject({ status: "unknown" });
    expect(k.center.feature("feature-exec")).toMatchObject({ authorityMode: "execution", epoch: 1 });
  });
});
