/**
 * team-project-UXWHO1 第 3 条：shared-projects 快照的 peers 带可选 instanceId（peers.json 里该 peer 已记的实例 id），
 * 协作视图「谁在干活」用它把执行实例换成成员机器名。没记的不带；网页解析照常（字段可选），形状不对按坏快照拒。
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PEERS_PATH } from "../src/lib/peers";
import { readSharedProjectsLocalSnapshot, sharedProjectsSnapshot } from "../src/bridge/local-api/shared-projects-snapshot";
import type { SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures";
import { ProjectFailure } from "../web/lib/shared-projects-model";
import { parseProjectSnapshot } from "../web/lib/shared-projects-parse";
import { projectSourceSnapshot } from "../web/lib/shared-projects-source";
import { peerInstanceNames } from "../web/features/collab/team-instance-names";

const p = createV2ProjectsFixtures();
const INST = "0f1e2d3c4b5a69788796a5b4";
const peer = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, baseUrl: "https://peer.example.test", outToken: "o".repeat(40), addedAt: "2026-10-01T00:00:00Z", ...extra });

beforeEach(async () => {
  await mkdir(dirname(PEERS_PATH), { recursive: true });
  writeFileSync(PEERS_PATH, JSON.stringify({ httpPeers: [peer("peer-mac", { instanceId: INST }), peer("old-peer"), peer("bad-id", { instanceId: "has space" })],
    pendingInvites: [] }));
});
afterAll(async () => { await rm(PEERS_PATH, { force: true }); });

const ports = { person: async () => ({ ...p.person, ...p.requests.list, subject: "owner:self" }), list: async () => [p.project],
  members: async () => [p.member], bindings: () => [{ ...p.identity, localProjectId: "local-a" }] } as unknown as SharedProjectsPorts;

test("[验收线 5] peers.json 记了实例 id 的 peer 回包带 instanceId，没记的（或形状不对的）不带", async () => {
  const local = await readSharedProjectsLocalSnapshot();
  expect(local.peers).toEqual([
    { name: "peer-mac", enabled: true, invitable: true, instanceId: INST },
    { name: "old-peer", enabled: true, invitable: true },
    { name: "bad-id", enabled: true, invitable: true },
  ]);
  const snap = await sharedProjectsSnapshot(ports, { projects: [], peers: local.peers });
  expect(snap.peers).toEqual(local.peers);
  expect("instanceId" in snap.peers[1]!).toBe(false);
});

test("[验收线 5] 网页解析：instanceId 透传到 peers，缺字段照常解析；名字表只收有实例 id 的", async () => {
  const local = await readSharedProjectsLocalSnapshot();
  const web = projectSourceSnapshot(await sharedProjectsSnapshot(ports, { projects: [], peers: local.peers }));
  expect(web.peers).toEqual([{ id: "peer-mac", name: "peer-mac", instanceId: INST }, { id: "old-peer", name: "old-peer" }, { id: "bad-id", name: "bad-id" }]);
  expect([...peerInstanceNames(web.peers)]).toEqual([[INST, "peer-mac"]]);
  const base = { teams: [{ centerId: "c", teamId: "t", personId: "x", teamRole: null }], projects: [], localProjects: [] };
  expect(parseProjectSnapshot({ ...base, peers: [{ id: "a", name: "a" }] }).peers).toEqual([{ id: "a", name: "a" }]);
  expect(() => parseProjectSnapshot({ ...base, peers: [{ id: "a", name: "a", instanceId: 42 }] })).toThrow(ProjectFailure);
});
