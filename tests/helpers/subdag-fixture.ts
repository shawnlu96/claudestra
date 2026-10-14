/**
 * 子 DAG 分区列表截图的夹具服务（team-project-SUBDAG4；SUBDAG5–8 的截图测试只 import 这里，不改）：本机和团队两侧的接口都由同一份节点数据生成——
 * 主线形状 F1（tests/web-collab-dag-fixture.ts 的 mainlineFeature / mainlineWork，本机节点另带 lastEvent）和一个全完成的 F9（12/12）。
 * 团队侧把节点落成中心的 list / detail（执行实例：主场 Studio，a-peer 在 Sekai），由页面自己的团队适配层转出子 DAG 和「谁在干活」；
 * 本机侧吐 /dag、/work、/product 与总览（总览由同一份团队投影去掉团队字段得到）。时钟固定在 MAIN_NOW：调用方 page.clock.setFixedTime(MAIN_NOW)。
 * extra(path, url, req)：后续卡加自己的接口，返回 null 落回这里的路由。
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { teamDagBoard, teamDagFeature } from "@/features/collab/team-source-dag";
import { sharedProductBoard } from "@/features/collab/dag/shared-product-model";
import type { BoardNode, DagBoard, FeatureCard } from "@/features/collab/dag/dag-types";
import type { LedgerOverview } from "@/features/collab/collab-model";
import type { FeatureDetail, FeatureList, PlanNode, TaskProjection } from "@/lib/api/shared-ledger";
import { feature, MAIN_NOW, mainlineFeature, mainlineWork, node } from "../web-collab-dag-fixture";

export { MAIN_NOW };
export const SUBDAG_PROJECT = "claude-orchestrator";
export const SUBDAG_TEAM = "team-a";
export const MAIN_TITLE = "子 DAG 主线";
export const DONE_TITLE = "已收尾的 feature";
const HOME = "inst-studio";
const SEKAI = "inst-sekai";
const MIN = 60_000;

/** 进行中节点在中心的阶段（a-owner 带一条开着的阻塞提问 = 团队的在等） */
const TEAM_STAGE: Record<string, string> = { "a-owner": "build", "a-ci": "merge", "a-pool": "review", "a-mq": "merge", "a-over": "build",
  "a-w1": "build", "a-w2": "build", "a-peer": "build" };
/** 本机节点的最近一条事件（SUBDAG2 的 lastEvent） */
const LAST_EVENT: Record<string, { ago: number; kind: string; text: string }> = {
  "a-owner": { ago: 50, kind: "ask", text: "接口命名二选一，等 owner 拍板" },
  "a-ci": { ago: 18, kind: "deliver", text: "交付 head 3f2a1c0，等 CI" },
  "a-pool": { ago: 88, kind: "stage", text: "write → review" },
  "a-mq": { ago: 9, kind: "decision", text: "进合并队列" },
  "a-over": { ago: 12, kind: "note", text: "测试夹具比预想的大，拆成两步" },
  "a-w1": { ago: 3, kind: "dispatch", text: "派给执行者" },
  "a-w2": { ago: 25, kind: "review", text: "第 1 轮审查：2 条 P2" },
  "a-peer": { ago: 14, kind: "scheduler", text: "出借给 Sekai" },
};

function localFeatures(now: number): FeatureCard[] {
  const main = mainlineFeature(now);
  const nodes = main.nodes.map((n): BoardNode => {
    const ev = LAST_EVENT[n.key];
    return ev ? { ...n, lastEvent: { at: now - ev.ago * MIN, actor: "scheduler", kind: ev.kind, text: ev.text } } : n;
  });
  const done = Array.from({ length: 12 }, (_, i) => {
    const key = `e${String(i + 1).padStart(2, "0")}`;
    return node(key, "done", i ? [`e${String(i).padStart(2, "0")}`] : [], { doneAt: now - (i + 2) * 3 * 60 * MIN, round: 1 + (i % 3) });
  });
  return [{ ...main, title: MAIN_TITLE, nodes }, feature("F9", done, { title: DONE_TITLE, status: "done" })];
}

function teamStage(n: BoardNode): string {
  if (n.phase === "done") return n.status === "cancelled" ? "cancelled" : "done";
  return TEAM_STAGE[n.key] ?? "build";
}

/** 同一份节点落成中心的 detail：没开工的节点不绑卡；步骤行照本机 stepLine */
function teamDetail(f: FeatureCard, now: number): FeatureDetail {
  const nodes: PlanNode[] = f.nodes.map((n) => ({ key: n.key, oneLine: n.oneLine, deps: n.deps, fileGlobs: [], estimate: n.estimate }));
  const tasks: TaskProjection[] = f.nodes.filter((n) => n.phase !== "idle").map((n, i) => ({
    taskId: `c-${n.key}`, sourceTaskId: n.taskId!, sourceRev: 1, sourceSeq: 10, stage: teamStage(n),
    assigneeCode: n.phase === "active" ? `dev-${(i % 3) + 1}` : null, executorInstanceId: n.key === "a-peer" ? SEKAI : HOME,
    pr: null, head: null, deps: n.deps, specSummary: n.oneLine, specDigest: null, fullText: "home_only",
    steps: (n.stepLine?.steps ?? []).map((st) => ({ sourceStepId: `${st.step}:${st.round}`, sourceRev: 1, sourceSeq: 10, state: st.state })),
    asks: n.key === "a-owner" ? [{ kind: "decide", state: "open", blocking: true }] : [],
  }));
  const completed = f.nodes.filter((n) => n.phase === "done").length;
  const feat: FeatureList["features"][number] = { id: f.id, projectId: SUBDAG_PROJECT, title: f.title, description: f.ownerWords || f.title,
    rev: 1, version: 1, authorityMode: "planning", homeInstanceId: HOME, executorInstanceIds: [HOME, SEKAI], status: f.status === "done" ? "done" : "active",
    counts: { total: f.nodes.length, completed, blocked: 0, missing: 0 }, updatedBy: "pm", updatedAt: now,
    projection: { sourceInstanceId: HOME, sourceSeq: 10, observedAt: now - MIN, receivedAt: now - MIN } };
  return { schemaVersion: 1, teamId: SUBDAG_TEAM, serverSeq: 5, capabilities: {}, feature: feat,
    dag: { version: 1, nodes, bindings: tasks.map((t) => ({ nodeKey: t.sourceTaskId.replace(/^T-/, ""), taskId: t.taskId })) }, tasks };
}

export function subdagFixture(now = MAIN_NOW) {
  const features = localFeatures(now);
  const details = new Map(features.map((f) => [f.id, teamDetail(f, now)]));
  const list: FeatureList = { schemaVersion: 1, teamId: SUBDAG_TEAM, serverSeq: 5, capabilities: {}, features: [...details.values()].map((d) => d.feature) };
  const teamOv = teamOverview(list, details, now);
  const teamBoard = teamDagBoard(SUBDAG_PROJECT, list, details, teamOv);
  // 本机总览：同一份投影去掉团队字段（执行镜像、未知轮次）
  const ov: LedgerOverview = { ...teamOv.ov, mirror: undefined, tasks: teamOv.ov.tasks.map((t) => {
    const { roundUnknown, team, ...rest } = t;
    void roundUnknown; void team;
    return { ...rest, round: 1 };
  }) };
  const board: DagBoard = { ...teamBoard, now, features: teamBoard.features.map((tf) => ({ ...tf, nodes: features.find((f) => f.id === tf.id)!.nodes })), agents: [] };
  return { list, details, teamOv, teamBoard, local: { board, ov, work: mainlineWork(now), product: sharedProductBoard(list, now, ov.tasks, details) } };
}

export type Extra = (path: string, url: URL, req: Request) => Response | null | Promise<Response | null>;

/** 回环 Bun.serve：bundle = fixture-harness.tsx 的构建目录；unexpected 记下夹具没答的 /api 请求 */
export function serveSubdag(bundle: string, opts: { now?: number; extra?: Extra } = {}) {
  const now = opts.now ?? MAIN_NOW;
  const fx = subdagFixture(now), p = SUBDAG_PROJECT, L = `/api/v1/ledger/${p}`;
  const files = readdirSync(bundle);
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const unexpected: string[] = [];
  const route = (path: string, url: URL, req: Request): Response | null => {
    if (path === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (path === "/api/v1/agents") return json({ ok: true, agents: [] });
    if (path === "/api/v1/presence") return json({ ok: true });
    if (path === "/api/v1/asks") return json({ ok: true, asks: [], now, canAnswer: true });
    if (path === "/api/v1/peers/contacts") return json({ contacts: [] });
    if (path === "/api/v1/team/quota") return json({ providers: [] });
    if (path === "/api/v1/lend/quota-lines") return json({ ok: true, at: now, config: { status: "ok", error: null, mode: "on" }, families: [] });
    if (path === "/api/v1/team/activity") return json({ now, interactions: [], truncated: false });
    if (path === "/api/v1/team/worker-context") return json({ known: false });
    if (path === "/api/v1/shared-projects/snapshot") return json({ v: 1, identity: { subject: "owner:self", kind: "person", centerId: "center-fixture", teamId: SUBDAG_TEAM,
      personId: "person-fixture", instanceId: "inst-viewer" }, teamRole: { available: true, value: "member" },
      capabilities: { invite: { available: false }, leave: { available: false } }, projects: [], localProjects: [],
      peers: [{ id: "peer-studio", name: "Studio", instanceId: HOME }, { id: "peer-sekai", name: "Sekai", instanceId: SEKAI }] });
    if (path === "/api/v1/shared-feature-proposals" && req.method === "GET") return json({ ok: true, operations: [] });
    if (path === `/api/v1/me/last-seen/${p}`) return req.method === "PUT" ? json({ ok: true }) : json({ lastSeen: now, now, events: [] });
    if (path === L) return json({ ok: true, ...fx.local.ov, now });
    if (path === `${L}/dag`) return json(fx.local.board);
    if (path === `${L}/product`) return json(fx.local.product);
    if (path === `${L}/work`) return json(fx.local.work);
    const feat = path.match(new RegExp(`^${L}/dag/([^/]+)$`));
    if (feat) return fx.local.board.features.some((f) => f.id === feat[1]) ? json(teamDagFeature(fx.local.board, feat[1]!)) : json({ error: "nf" }, 404);
    if (path === "/api/v1/shared-ledger/context") return json({ identities: [] });
    if (path === "/api/v1/shared-ledger/features") return json(fx.list);
    const shared = path.match(/^\/api\/v1\/shared-ledger\/features\/(.+)$/);
    if (shared) return fx.details.has(shared[1]!) ? json(fx.details.get(shared[1]!)) : json({ error: "nf" }, 404);
    void url;
    return null;
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = decodeURIComponent(url.pathname);
    const hit = (await opts.extra?.(path, url, req)) ?? route(path, url, req);
    if (hit) return hit;
    if (path.startsWith("/api/")) {
      if (!/^\/api\/v1\/(events|agents\/)/.test(path)) unexpected.push(`${req.method} ${path}`);
      return json({ ok: false, error: "not in fixture" }, 404);
    }
    if (path !== "/") return files.includes(path.slice(1)) ? new Response(Bun.file(resolve(bundle, path.slice(1)))) : new Response(null, { status: 404 });
    return new Response(`<!doctype html><html data-theme="light"><head><meta charset="utf-8">
      ${files.filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="/${f}">`).join("")}
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
      h5{margin:0}#root{height:100vh;position:relative}</style></head>
      <body><div id="root"></div><script type="module" src="/${files.find((f) => f.endsWith(".js"))}"></script></body></html>`,
    { headers: { "content-type": "text/html" } });
  } });
  return { server, fx, unexpected };
}
