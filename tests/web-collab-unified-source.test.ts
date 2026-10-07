/** team-project-N8：项目组「协作视图」选源（纯函数）与每机一份 context store（单飞、晚回包、错误分级）。合成身份，不连 bridge。 */
import { afterEach, beforeAll, expect, test } from "bun:test";
import { ApiError } from "../web/lib/api/client";
import { machines } from "../web/lib/machines";
import { bindingState, parseContext, refreshBindings, resolveCollabSource, setContextRequestForTest, subscribeBindings,
  type ContextIdentity } from "../web/lib/collab-source-binding";
import { sharedCollabProject } from "../web/features/collab/team-source-key";

const C = "center-1", A: ContextIdentity = { center: C, team: "team-a", person: "p-a", project: "proj-x", localProjectId: "claudestra", homeInstanceId: "inst-a" };

beforeAll(async () => {
  await machines.add({ fp: "mac-a", name: "A" });
  await machines.add({ fp: "mac-b", name: "B" });
  await machines.setCurrent("mac-a");
});
afterEach(async () => {
  setContextRequestForTest(null);
  await machines.setCurrent("mac-a");
});

test("已绑定：key 与 N5 侧栏 projects-entry 的输入同字节", () => {
  const r = resolveCollabSource([A], "claudestra", "mac-a");
  expect(r.kind).toBe("center");
  // projects-entry.tsx:26 的拼法：machine / center / team / project / person / homeInstanceId
  const n5 = sharedCollabProject({ machine: "mac-a", center: C, team: "team-a", project: "proj-x", person: "p-a", homeInstanceId: "inst-a" });
  expect(r.kind === "center" && r.key).toBe(n5);
  expect(r.kind === "center" && r.identity.machine).toBe("mac-a");
});

test("两台机器本机 id 不同、绑定同一中心项目：各自命中，中心项目相同", () => {
  const b = { ...A, person: "p-b", localProjectId: "claude-orchestrator", homeInstanceId: "inst-b" };
  const ra = resolveCollabSource([A], "claudestra", "mac-a"), rb = resolveCollabSource([b], "claude-orchestrator", "mac-b");
  expect(ra.kind === "center" && rb.kind === "center" && ra.identity.project === rb.identity.project).toBe(true);
  expect(resolveCollabSource([b], "claudestra", "mac-b")).toEqual({ kind: "local" });
});

test("没有 localProjectId 时按中心 projectId 匹配；只认 id，不认名字", () => {
  const { localProjectId: _, ...plain } = A;
  expect(resolveCollabSource([plain], "proj-x", "m").kind).toBe("center");
  // 有 localProjectId 时中心 projectId 同名的本机项目不算绑定
  expect(resolveCollabSource([A], "proj-x", "m")).toEqual({ kind: "local" });
  expect(resolveCollabSource([A], "Claudestra", "m")).toEqual({ kind: "local" });
  expect(resolveCollabSource([], "claudestra", "m")).toEqual({ kind: "local" });
});

test("同一中心 projectId 跨团队 → ambiguous；同名不同 center/team 的另一个本机项目不被当成已绑定", () => {
  const other = { ...A, team: "team-b", localProjectId: "elsewhere" };
  expect(resolveCollabSource([A, other], "claudestra", "m")).toEqual({ kind: "blocked", reason: "ambiguous" });
  expect(resolveCollabSource([A, other], "elsewhere", "m")).toEqual({ kind: "blocked", reason: "ambiguous" });
  const twoForOne = { ...A, project: "proj-y" };
  expect(resolveCollabSource([A, twoForOne], "claudestra", "m")).toEqual({ kind: "blocked", reason: "ambiguous" });
  const sameName = { ...A, center: "center-2", project: "proj-z", localProjectId: "claudestra-2" };
  expect(resolveCollabSource([sameName], "claudestra", "m")).toEqual({ kind: "local" });
});

test("从没读成功过 → checking；中心 key 被撤权 → revoked", () => {
  expect(resolveCollabSource(null, "claudestra", "m")).toEqual({ kind: "blocked", reason: "checking" });
  const r = resolveCollabSource([A], "claudestra", "m");
  const key = r.kind === "center" ? r.key : "";
  expect(resolveCollabSource([A], "claudestra", "m", (k) => k === key)).toEqual({ kind: "blocked", reason: "revoked" });
});

test("parseContext 丢掉缺字段条目", () => {
  expect(parseContext({ identities: [A, { ...A, person: "" }, null, { center: C }] })).toEqual([A]);
  expect(parseContext(null)).toEqual([]);
});

function deferred() {
  let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

test("单飞：多个订阅者 / 多次刷新只发一次", async () => {
  let calls = 0;
  const d = deferred();
  setContextRequestForTest(() => (calls++, d.promise));
  const off = [subscribeBindings("mac-a", () => {}), subscribeBindings("mac-a", () => {})];
  void refreshBindings("mac-a");
  expect(calls).toBe(1);
  d.resolve({ identities: [A] });
  await refreshBindings("mac-a"); // 在途时直接返回
  await Bun.sleep(0);
  expect(bindingState("mac-a")).toEqual({ fp: "mac-a", identities: [A], settled: true });
  off.forEach((f) => f());
});

test("换机器后旧机器的晚到回包丢弃", async () => {
  const d = deferred();
  setContextRequestForTest(() => d.promise);
  const off = subscribeBindings("mac-a", () => {});
  await machines.setCurrent("mac-b");
  d.resolve({ identities: [A] });
  await Bun.sleep(0);
  expect(bindingState("mac-a").identities).toBeNull();
  off();
});

test("被新一轮取代（最后订阅者走了再回来）后，上一轮回包不落", async () => {
  const first = deferred(), second = deferred();
  const queue = [first, second];
  setContextRequestForTest(() => queue.shift()!.promise);
  const off = subscribeBindings("mac-a", () => {});
  off(); // 作废在途
  const off2 = subscribeBindings("mac-a", () => {});
  first.resolve({ identities: [{ ...A, team: "stale" }] });
  second.resolve({ identities: [A] });
  await Bun.sleep(0);
  expect(bindingState("mac-a").identities).toEqual([A]);
  off2();
});

test("401/403/404 → 按未绑定（空列表）；5xx 从没成功过 → 仍是 null 但 settled；成功过 → 保留上次", async () => {
  for (const status of [401, 403, 404]) {
    setContextRequestForTest(() => Promise.reject(new ApiError("x", status)));
    await refreshBindings("mac-a");
    expect(bindingState("mac-a")).toEqual({ fp: "mac-a", identities: [], settled: true });
  }
  const warn = console.warn;
  console.warn = () => {};
  try {
    setContextRequestForTest(() => Promise.reject(new ApiError("boom", 503)));
    await refreshBindings("mac-a");
    expect(bindingState("mac-a")).toEqual({ fp: "mac-a", identities: null, settled: true });
    setContextRequestForTest(null);
    let ok = true;
    setContextRequestForTest(() => ok ? Promise.resolve({ identities: [A] }) : Promise.reject(new TypeError("network")));
    await refreshBindings("mac-a");
    ok = false;
    await refreshBindings("mac-a");
    expect(bindingState("mac-a").identities).toEqual([A]);
  } finally { console.warn = warn; }
});

test("过期 key 与撤权记忆在 store 里算：改绑 A→B → A 过期；身份消失 → 记下消失前的 key；再绑定 / context 401 清掉", async () => {
  const { staleCenterKeys, lostCenterKey } = await import("../web/lib/collab-source-binding");
  let body: unknown = { identities: [A] };
  setContextRequestForTest(() => body instanceof ApiError ? Promise.reject(body) : Promise.resolve(body));
  await refreshBindings("mac-a");
  const r = resolveCollabSource([A], "claudestra", "mac-a"), keyA = r.kind === "center" ? r.key : "";
  expect([...staleCenterKeys("mac-a")]).toEqual([]);
  body = { identities: [{ ...A, project: "proj-y" }] };
  await refreshBindings("mac-a");
  expect([...staleCenterKeys("mac-a")]).toEqual([keyA]);
  expect(lostCenterKey("mac-a", "claudestra")).toBeNull(); // 仍绑定（换了中心项目），不算消失
  body = { identities: [A] };
  await refreshBindings("mac-a");
  expect(staleCenterKeys("mac-a").has(keyA)).toBe(false); // 绑回来就不再过期
  body = { identities: [] };
  await refreshBindings("mac-a");
  expect(lostCenterKey("mac-a", "claudestra")).toBe(keyA);
  expect(staleCenterKeys("mac-a").has(keyA)).toBe(true);
  // 消失前的 key 已确认 403 → revoked；没确认 → 本机（普通解绑）
  expect(resolveCollabSource([], "claudestra", "mac-a", (k) => k === keyA, keyA)).toEqual({ kind: "blocked", reason: "revoked" });
  expect(resolveCollabSource([], "claudestra", "mac-a", () => false, keyA)).toEqual({ kind: "local" });
  body = new ApiError("x", 401);
  await refreshBindings("mac-a");
  expect(lostCenterKey("mac-a", "claudestra")).toBeNull();
  body = { identities: [] };
  await refreshBindings("mac-a");
  body = { identities: [A] };
  await refreshBindings("mac-a");
  expect(lostCenterKey("mac-a", "claudestra")).toBeNull();
});

test("撤权记忆跨过 ambiguous 中间态：A → 跨团队不可区分 → 身份消失，仍记得 A；context 401 清掉", async () => {
  const { lostCenterKey } = await import("../web/lib/collab-source-binding");
  let body: unknown = { identities: [A] };
  setContextRequestForTest(() => body instanceof ApiError ? Promise.reject(body) : Promise.resolve(body));
  await refreshBindings("mac-a");
  const r = resolveCollabSource([A], "claudestra", "mac-a"), keyA = r.kind === "center" ? r.key : "";
  body = { identities: [A, { ...A, team: "team-other", localProjectId: "elsewhere" }] };
  await refreshBindings("mac-a");
  expect(lostCenterKey("mac-a", "claudestra")).toBeNull(); // 还在 context 里（只是不可区分）
  body = { identities: [] };
  await refreshBindings("mac-a");
  expect(lostCenterKey("mac-a", "claudestra")).toBe(keyA);
  body = new ApiError("x", 401);
  await refreshBindings("mac-a");
  expect(lostCenterKey("mac-a", "claudestra")).toBeNull();
});
