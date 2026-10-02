import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pmPointer } from "../src/lib/pm-role.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { pmStatus } from "../src/lib/pm-role-status.js";
import { A, B, P, Q, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [];
const fixture = () => { const f = pmFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const switchTo = (f: ReturnType<typeof pmFixture>, dryRun = false) => switchProjectPm(f.db, P, B, { actor: "owner", dryRun, now: 100 }, f.deps);
const file = (f: ReturnType<typeof pmFixture>, name: string) => JSON.parse(readFileSync(join(f.dir, name), "utf8"));

test("peer-prs keeps peers[].agent when both machines' PMs share a name; only replyTo moves", async () => {
  const f = fixture();
  const dry = await switchTo(f, true);
  expect(dry.changes.map((c) => c.location)).not.toContain("peer-prs.peers[0].agent");
  const r = await switchTo(f);
  expect(file(f, "peer-prs.json")).toMatchObject({ replyTo: `${B}@remote`, peers: [{ peer: "remote", agent: A }], extra: "preserve" });
  expect(r.status?.ok).toBe(true);
  expect(r.notifications.map((n) => n.target)).toContain(`${A}@remote`);
});

test("another project's peer token does not block this project's switch, dry run or real", async () => {
  const f = fixture(), principals = file(f, "principals.json").principals;
  principals.push({ id: "token:tok_x", role: "external", peer: "remote-x", agents: ["agent-other"], createdAt: "2026-01-01" });
  f.put("principals.json", { principals });
  expect((await switchTo(f, true)).ok).toBe(true);
  await switchTo(f);
  expect(pmPointer(f.db, P)).toBe(B);
  expect(pmStatus(f.db, P, await f.deps.read()).entries.map((e) => e.location)).not.toContain("peer-token:token:tok_x");
});

test("this project's peer token lacking the candidate still blocks the switch", async () => {
  const f = fixture(), principals = file(f, "principals.json").principals;
  principals[0].agents = [A];
  f.put("principals.json", { principals });
  await expect(switchTo(f, true)).rejects.toThrow("lacks agent-beta");
});

test("switch works without peer-prs.json", async () => {
  const f = fixture();
  rmSync(join(f.dir, "peer-prs.json"));
  expect((await switchTo(f, true)).ok).toBe(true);
  const r = await switchTo(f);
  expect(pmPointer(f.db, P)).toBe(B);
  expect(r.notifications.map((n) => n.target)).toEqual([B, A]);
});

test("peer-prs.json of another project is neither checked, rewritten nor notified", async () => {
  const f = fixture();
  f.put("peer-prs.json", { enabled: true, project: Q, replyTo: `${A}@remote`, peers: [] });
  const before = readFileSync(join(f.dir, "peer-prs.json"), "utf8");
  expect((await switchTo(f, true)).ok).toBe(true);
  f.put("peer-prs.json", { enabled: true, project: Q, replyTo: `${A}@remote`, peers: [{ peer: "remote", agent: A }] });
  const r = await switchTo(f);
  expect(r.notifications.map((n) => n.target)).toEqual([B, A]);
  expect(file(f, "peer-prs.json").replyTo).toBe(`${A}@remote`);
  expect(before).toContain(Q);
});

test("fields another writer changes during the switch survive the config and peer-prs writes", async () => {
  const f = fixture(), online = f.deps.online;
  f.deps.online = async () => {
    f.put("config.json", { ...file(f, "config.json"), lang: "zh", added: true });
    f.put("peer-prs.json", { ...file(f, "peer-prs.json"), extra: "changed" });
    return online();
  };
  await switchTo(f);
  expect(file(f, "config.json")).toMatchObject({ lang: "zh", added: true, groqApiKey: "CONFIG-SECRET", autoCompact: { policies: [{ match: { names: [B] } }] } });
  expect(file(f, "peer-prs.json")).toMatchObject({ extra: "changed", replyTo: `${B}@remote` });
});

test("rollback restores only PM fields and keeps another writer's change", async () => {
  const f = fixture();
  f.deps.writeConfig = async () => {
    f.put("peer-prs.json", { ...file(f, "peer-prs.json"), added: 1 });
    throw new Error("disk unavailable");
  };
  await expect(switchTo(f)).rejects.toThrow("disk unavailable");
  expect(file(f, "peer-prs.json")).toMatchObject({ replyTo: `${A}@remote`, added: 1, extra: "preserve" });
  expect(pmPointer(f.db, P)).toBeNull();
});
