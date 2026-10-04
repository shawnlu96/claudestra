/**
 * team-parity-C 团队一侧的唯一来路：把 home-fixture-gen.ts 那一份本机台账落进临时 sqlite 台账，然后只走生产代码——
 * previewSharedLedgerExport（导出）→ 真中心 LedgerService 导入 → pushSharedLedgerMirror（mirrorTaskProjections 全量快照）→
 * 中心读口 GET features / features/:id（refreshFeatureState 算的 counts / status）。这里没有任何投影或归并规则的副本：
 * 生产规则一变，团队夹具跟着变。落库只用台账写口（importTask / initDag / rewriteDag / addDep）；步骤行、提问行没有公开写口，
 * 直接插行（同 tests/shared-ledger-projector.test.ts 的做法）。只碰临时目录、不连网络；用例在 web-team-parity-browser-fixture.test.ts。
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, importTask, setMeta } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { approveDag, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { answerAsk } from "../src/lib/ledger-asks.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { previewSharedLedgerExport } from "../src/lib/shared-ledger-export.js";
import { pushSharedLedgerMirror, type MirrorEntry } from "../src/lib/shared-ledger-projector.js";
import { signSharedLedgerRequest, sharedLedgerCredentialHash, type SharedLedgerCredential } from "../src/lib/shared-ledger-auth.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";
import { Store } from "../src/shared-ledger/store.js";
import { LedgerService } from "../src/shared-ledger/service.js";
import { registerCredential } from "../src/shared-ledger/identity.js";
import type { InstanceKey } from "../src/lib/instance-key.js";
import type { HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import type { FeatureDetail, FeatureList } from "@/lib/api/shared-ledger";

export interface TeamFromHome { list: FeatureList; details: FeatureDetail[]; localFeature: Record<string, string> }

const OWNER = "owner", PM = "agent-pm-a";
const SCRUB_IDENTITY = { username: "parity-user", hostname: "parity-host" };
const IMPORTABLE = new Set(["stage", "review", "verify"]);

/** 本机夹具 → 临时台账：卡按事件链 importTask（落在最终阶段），DAG 两版走 initDag / rewriteDag，依赖走 addDep */
function materialize(db: Database, home: HomeFixture): Record<string, string> {
  const p = home.project, owner = { actor: OWNER, now: home.now - 8 * 3600_000 };
  db.run("INSERT INTO ledger_instance VALUES ('origin', 'home')");
  setMeta(db, owner, { project: p, key: "pms", value: [PM] });
  for (const t of home.overview.tasks) {
    const d = home.details[t.id]!, row = home.rows[t.id]!;
    importTask(db, { actor: OWNER }, { createdTs: d.events[0]!.ts, initialStage: "spec",
      task: { project: p, id: t.id, title: t.title, kind: t.kind as "code", stage: t.stage, round: t.round, agent: t.agent, pm: t.pm, pr: t.pr, headSHA: row.headSHA, spec: t.spec },
      events: d.events.filter((e) => IMPORTABLE.has(e.kind)).map((e) => ({ kind: e.kind as "stage", ts: e.ts, text: e.text, data: e.data })) });
    const step = db.prepare("INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, verdict, rev, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)");
    for (const s of row.steps) step.run(t.id, s.step, s.round, s.executor, "agent", s.state, s.verdict, s.rev, t.updatedAt, t.updatedAt);
    const ask = db.prepare("INSERT INTO asks (id, project, taskId, fromAgent, fromChannelId, source, kind, blocking, title, expiresAt, state, createdAt, updatedAt)"
      + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    row.asks.forEach((a, i) => ask.run(`ask-${t.id}-${i}`, p, t.id, t.agent ?? PM, "fixture", a.source, a.kind, a.blocking, "提问", home.now + 86_400_000, a.state, home.now, home.now));
  }
  const local: Record<string, string> = {};
  for (const f of home.features) {
    const pm = { actor: PM, now: f.versions[0]!.meta.createdAt };
    const id = createFeature(db, pm, { project: p, slug: f.id, title: f.title, ownerWords: f.ownerWords }).row.id;
    local[f.id] = id;
    const nodes = (v: HomeFixture["features"][number]["versions"][number]) => v.nodes.map(({ key, oneLine, deps, fileGlobs, estimate, taskId }) =>
      ({ key, oneLine, deps, fileGlobs, estimate, ...(taskId ? { taskId } : {}) }));
    const [v1, v2] = f.versions;
    initDag(db, pm, { id, rev: getFeature(db, id)!.rev, nodes: nodes(v1!), reasonText: v1!.meta.reasonText });
    const r = rewriteDag(db, { actor: PM, now: v2!.meta.createdAt }, { id, rev: getFeature(db, id)!.rev, nodes: nodes(v2!), reasonKind: v2!.meta.reasonKind,
      reasonText: v2!.meta.reasonText, cancel: new Map(), scopeChange: v2!.meta.scopeChange, askFrom: { agent: PM, channelId: null } });
    // 改范围的重写要 owner 批：照生产流程答 ask 再 approveDag，不直接插版本行
    if (r.row.ask) answerAsk(db, r.row.ask.id, { choices: ["[button:dag_rewrite_approve]"], labels: ["批准"], text: "",
      principal: OWNER, via: "web_card", at: v2!.meta.createdAt, owner: true });
    if (r.row.ask && !approveDag(db, { actor: PM, now: v2!.meta.createdAt }, { id }).row.applied) throw new Error(`DAG v2 of ${f.id} not applied`);
  }
  for (const d of home.overview.deps ?? []) addDep(db, { actor: PM, now: d.createdAt ?? undefined }, { from: d.from, to: d.to, when: d.when as "verified" });
  return local;
}

/** 一个只活在本进程里的真中心：home 是服务凭据（导入 / 投影），member 是看团队视图的人（只读 + 规划） */
function center(home: HomeFixture, dir: string) {
  const store = new Store(join(dir, "center.sqlite")), service = new LedgerService(store), now = home.now;
  const keys = new Map<string, InstanceKey>();
  const secrets = new Map<string, string>(), creds = new Map<string, SharedLedgerCredential>();
  const add = (person: string, instanceId: string, role: "member" | "service") => {
    const pair = generateKeyPairSync("ed25519"), key = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
    const secret = randomBytes(24).toString("hex");
    const c: SharedLedgerCredential = { credentialHash: sharedLedgerCredentialHash(secret), teamId: home.team, personId: person, instanceId,
      publicKey: key.publicKey, membershipStatus: "active", revokedAt: null, expiresAt: now + 86_400_000,
      projects: [{ projectId: home.project, role, actions: role === "service" ? ["read", "plan", "import", "project"] : ["read", "plan"] }] };
    keys.set(person, key); secrets.set(person, secret); creds.set(person, c);
    registerCredential(store, c, person);
  };
  add("home", home.sourceInstanceId, "service");
  add("person-a", "instance-viewer", "member");
  const call = (person: string, resource: string, payload: unknown = null, method = "POST") => {
    const attemptNonce = randomBytes(16).toString("hex");
    const req = signSharedLedgerRequest({ method, path: `/v1/teams/${home.team}/${resource}`, body: method === "GET" ? "" : JSON.stringify({ attemptNonce, payload }),
      bearer: secrets.get(person)!, instanceId: creds.get(person)!.instanceId, ts: String(Math.floor(now / 1000)), attemptNonce }, keys.get(person)!);
    const r = service.handle(req, now);
    if (r.status !== 200) throw new Error(`center ${method} ${resource} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as Record<string, unknown>;
  };
  return { call, close: () => store.close() };
}

/**
 * 同一份本机数据 → 中心读口给团队视图的 FeatureList / FeatureDetail。authorityMode 缺省 planning（导入时开了共享规划）。
 * 投影来自真投影器：头只认 home.commits 里的提交，URL 形式的 PR 变 null，隐藏来源的提问被滤，都由生产规则决定。
 */
export async function teamFromHome(home: HomeFixture, opts: { authorityMode?: "planning" | "source" } = {}): Promise<TeamFromHome> {
  const dir = mkdtempSync(join(tmpdir(), "team-parity-c-")), ledgerPath = join(dir, "ledger.sqlite"), db = openLedger(ledgerPath);
  const hub = center(home, dir);
  try {
    const local = materialize(db, home), ids = Object.values(local), authorityMode = opts.authorityMode ?? "planning";
    for (const id of ids) await writeSharedLedgerMode(id, { authorityMode, sharedPlanning: true }, dir, ledgerPath);
    const heads = Object.values(home.rows).flatMap((r) => (r.headSHA ? [r.headSHA.toLowerCase()] : []));
    const summaries = Object.fromEntries(Object.entries(home.rows).map(([id, r]) => [id, { summary: r.meta.specSummary, digest: r.meta.specDigest }]));
    // 导出闸只放已知提交的 head：导入这一步全部放行，紧接着的镜像快照按 home.commits 真实规则把未知 head 改成 null
    const { payload } = previewSharedLedgerExport(db, { localProject: home.project, projectId: home.project, sourceInstanceId: home.sourceInstanceId,
      featureIds: ids, batchId: "parity-c", stateDir: dir, scrub: { identity: SCRUB_IDENTITY, commits: new Set(heads) }, summaries });
    const imported = hub.call("home", "imports", { ...payload, mode: "commit", manifestDigest: sharedLedgerManifestDigest(payload.manifest) });
    const mapping = new Map((imported.mappings as { kind: string; sourceId: string; id: string }[]).filter((m) => m.kind === "feature").map((m) => [m.sourceId, m.id]));
    appendEvent(db, { actor: PM, now: home.now }, { project: home.project, target: "", kind: "note", text: "镜像推送前的本机活动" });
    const taskMeta = Object.fromEntries(Object.entries(home.rows).map(([id, r]) => [id, r.meta]));
    for (const id of ids) {
      const entry: MirrorEntry = { enabled: true, batchId: "parity-c", centerId: "center", teamId: home.team, projectId: home.project, centerFeatureId: mapping.get(id)!,
        sourceInstanceId: home.sourceInstanceId, localProject: home.project, watermark: payload.manifest.sourceSeq, snapshot: true, fingerprints: {}, taskMeta,
        lastPushAt: null, lastPushSeq: null, lastError: null, lastErrorAt: null, failures: 0, nextAttemptAt: 0 };
      const r = await pushSharedLedgerMirror(db, id, entry, { now: home.now, scrub: { identity: SCRUB_IDENTITY, commits: new Set(home.commits.map((c) => c.toLowerCase())) },
        client: { async projection(input) { return hub.call("home", "projections", input) as never; } } });
      if (r.outcome.kind !== "pushed") throw new Error(`mirror push for ${id}: ${JSON.stringify(r.outcome)}`);
    }
    // list 保持中心给的顺序（团队视图真实看到的）；details 按本机 feature 顺序排，测试按下标取
    const list = hub.call("person-a", "features", null, "GET") as unknown as FeatureList;
    const homeOf = new Map([...mapping].map(([l, c]) => [c, Object.entries(local).find(([, x]) => x === l)![0]]));
    const order = (id: string) => home.features.findIndex((f) => f.id === homeOf.get(id));
    const details = list.features.map((f) => hub.call("person-a", `features/${f.id}`, null, "GET") as unknown as FeatureDetail)
      .sort((a, b) => order(a.feature.id) - order(b.feature.id));
    return { list, details, localFeature: Object.fromEntries(details.map((d) => [d.feature.id, homeOf.get(d.feature.id)!])) };
  } finally { hub.close(); closeLedger(ledgerPath); rmSync(dir, { recursive: true, force: true }); }
}

