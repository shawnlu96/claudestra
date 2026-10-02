import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta, createTask } from "../src/lib/ledger-write.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import { readPmState } from "../src/lib/pm-role-state.js";
import { writeJsonStateGuarded } from "../src/lib/state-file.js";
import { writePeerPrConfig } from "../src/lib/peer-pr-config.js";
import type { PmSwitchDeps } from "../src/lib/pm-role-switch.js";

export const P = "project-one", Q = "project-two", A = "agent-alpha", B = "agent-beta", D = "agent-dispatcher";
export function pmFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pm-role-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const put = (file: string, value: unknown) => writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [D, A, B] });
  setMeta(db, { actor: "owner" }, { project: P, key: "team", value: { dispatcher: D, audit: true } });
  setMeta(db, { actor: "owner" }, { project: Q, key: "pms", value: ["agent-other"] });
  createTask(db, { actor: A }, { project: P, id: "T1", title: "history", kind: "code", pm: A });
  const agents = [
    { name: A, projectId: P, channelId: "channel-a", runtime: "claude-code" },
    { name: B, projectId: P, channelId: "channel-b", runtime: "codex" },
    { name: D, projectId: P, channelId: "channel-d" },
    { name: "agent-other", projectId: Q, channelId: "channel-other" },
    ...["task-1", "rv-1", "cx-1", "lend-1", "worker-1"].map((name) => ({ name: `agent-${name}`, projectId: P })),
    { name: "agent-hidden", kind: "worker" as const, projectId: P },
  ];
  put(basename(REGISTRY_PATH), { agents: Object.fromEntries(agents.map(({ name, ...v }) => [name, { ...v, status: "active" }])) });
  put("principals.json", { principals: [
    { id: "token:tok_peer", role: "external", peer: "remote", agents: [A, B], secret: "DO-NOT-RETURN", createdAt: "2026-01-01" },
    { id: "token:tok_retired", role: "external", disabled: true, agents: [A], secret: "DISABLED-SECRET", createdAt: "2026-01-01" },
  ] });
  put("peers.json", { httpPeers: [{ name: "remote", addedAt: "2026-01-01", inTokenId: "tok_peer", outToken: "REMOTE-SECRET" }] });
  put("peer-prs.json", { enabled: true, project: P, replyTo: `${A}@remote`, peers: [{ peer: "remote", agent: A }], extra: "preserve" });
  put("config.json", { lang: "en", groqApiKey: "CONFIG-SECRET", autoCompact: { policies: [{ match: { names: [A] } }] } });
  put("team-proposals.json", {});
  put("cron.json", { jobs: [] });
  const online = new Set([A, B, D, "agent-other"]), notices: { target: string; text: string }[] = [];
  const deps: PmSwitchDeps = {
    read: () => readPmState(dir), online: async () => online, lockPath: join(dir, "pm-switch.lock"),
    writePeerPrs: (v) => writePeerPrConfig(v, join(dir, "peer-prs.json")),
    writeConfig: (v) => writeJsonStateGuarded(join(dir, "config.json"), v),
    notify: async (target, text) => { notices.push({ target, text }); },
  };
  const bytes = () => ["peer-prs.json", "config.json", "principals.json", "peers.json", "team-proposals.json", "cron.json"]
    .map((file) => readFileSync(join(dir, file), "utf8"));
  return { db, dir, path, put, deps, online, notices, bytes, close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}
