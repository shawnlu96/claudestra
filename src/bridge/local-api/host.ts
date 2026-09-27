/**
 * 主机能力（原 web BFF 的 host / agents/open / projects/open）——只对**本机浏览器**有意义：
 *   GET  /api/v1/host                     本机 { local:true, platform, openers:[{id,label,kind}] }；否则 { local:false, localEntry? }（装了什么软件不告诉远端）
 *   POST /api/v1/agents/:name/open {with} 用本机程序打开会话的工作目录（registry 的 cwd；master 用 MASTER_DIR）
 *   POST /api/v1/projects/:id/open {with, index?} 打开 project 的第 index 个目录
 * 「本机」= 真实回环，或来源地址是本机网卡地址（lib/same-host.ts：localhost / 局域网 IP / 自己的 tailnet 域名都算，只信本机反代加的 XFF）。
 * 经中继的请求判不了网络位置：直托管时回 localEntry {port, sameNetwork}，前端自己探回环后切到本机直连（web/features/machines/local-hop.ts）。
 * 目录来自 registry / projects.json，程序 id 只在 lib/host-openers.ts 的表里被认——路径与命令都不接受外部输入。
 */
import { canManage } from "../../lib/devices.js";
import { currentPlatform, openDirectory, probeOpeners, type OpenResult } from "../../lib/host-open.js";
import type { Principal } from "../../lib/principals.js";
import { readProjects } from "../../lib/projects.js";
import { isSameHostRequest } from "../../lib/same-host.js";
import { isMasterAgent, readRegistryAgents } from "../../lib/registry.js";
import { apiJson, forbidden, inScopeEitherName, INVALID_JSON, invalidJsonBody, notInScope, readJsonBody } from "../api-respond.js";
import { BRIDGE_PORT, MASTER_DIR } from "../config.js";
import { requestContextOf } from "../request-context.js";

interface Deps {
  registryPath?: string;
  projectsPath?: string;
  masterDir: string;
  open: (id: string, dir: string) => Promise<OpenResult>;
}
const realDeps: Deps = { masterDir: MASTER_DIR, open: openDirectory };
let deps = realDeps;
/** 单测：registry / projects 指到临时文件、open 换成记录 argv 的假实现；生产不调 */
export function setHostDepsForTest(d: Partial<Deps> | undefined): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
}

function isLocal(req: Request): boolean {
  const ctx = requestContextOf(req);
  if (ctx.source === "loopback") return true;
  return ctx.source === "lan" && isSameHostRequest(ctx.clientIp, req.headers.get("x-forwarded-for"));
}

/** 经中继来的请求：这台机器直托管前端时告诉前端本机入口的端口（中继页面本就知道 fp，端口不算新信息） */
function localEntry(req: Request): { port: number; sameNetwork: boolean } | undefined {
  const ctx = requestContextOf(req);
  if (ctx.source !== "relay" || !process.env.BRIDGE_STATIC_DIR) return undefined;
  return { port: BRIDGE_PORT, sameNetwork: ctx.sameNetwork === true };
}

const NOT_LOCAL = "opening directories is only available from this machine";

export async function handleHost(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path === "/host" && req.method === "GET") return hostInfo(req);
  const a = path.match(/^\/agents\/([^/]+)\/open$/);
  if (a && req.method === "POST") return openAgent(req, principal, decodeURIComponent(a[1]));
  const p = path.match(/^\/projects\/([^/]+)\/open$/);
  if (p && req.method === "POST") return openProject(req, principal, decodeURIComponent(p[1]));
  return null;
}

function hostInfo(req: Request): Response {
  const entry = localEntry(req);
  const res = isLocal(req)
    ? apiJson(200, { ok: true, local: true, platform: currentPlatform(), openers: probeOpeners() })
    : apiJson(200, { ok: true, local: false, ...(entry ? { localEntry: entry } : {}) });
  res.headers.set("cache-control", "no-store");
  return res;
}

type Body = Record<string, unknown>;
type DirLookup = (body: Body) => Promise<string | { notFound: string }>;

/** 两个 open 端点共用：回环 → 体里的 with → 目录 → spawn */
async function openWith(req: Request, dirOf: DirLookup): Promise<Response> {
  if (!isLocal(req)) return forbidden(NOT_LOCAL);
  const raw = await readJsonBody(req);
  if (raw === INVALID_JSON) return invalidJsonBody();
  const body = (raw && typeof raw === "object" ? raw : {}) as Body;
  const opener = body.with;
  if (typeof opener !== "string" || !opener) return apiJson(400, { ok: false, error: '"with" (opener id from GET /host) required' });
  const dir = await dirOf(body);
  if (typeof dir !== "string") return apiJson(404, { ok: false, error: dir.notFound });
  const r = await deps.open(opener, dir);
  return r.ok ? apiJson(200, { ok: true, dir }) : apiJson(422, { ok: false, error: r.error });
}

async function openAgent(req: Request, principal: Principal, name: string): Promise<Response> {
  if (!isLocal(req)) return forbidden(NOT_LOCAL);
  if (!inScopeEitherName(principal, name)) return notInScope(name);
  return openWith(req, async () => {
    if (isMasterAgent(name)) return deps.masterDir;
    const hit = (await readRegistryAgents(deps.registryPath)).find((a) => a.name === name || a.name === `agent-${name}`);
    if (!hit) return { notFound: `agent "${name}" not found` };
    return hit.cwd || { notFound: `agent "${name}" has no recorded working directory` };
  });
}

async function openProject(req: Request, principal: Principal, id: string): Promise<Response> {
  if (!isLocal(req)) return forbidden(NOT_LOCAL);
  if (!canManage(principal)) return forbidden("projects require a credential with manage grant");
  return openWith(req, async (body) => {
    const project = (await readProjects(deps.projectsPath)).projects.find((p) => p.id === id);
    if (!project) return { notFound: `project "${id}" not found` };
    const index = body.index === undefined ? 0 : Number(body.index);
    const dir = Number.isInteger(index) && index >= 0 ? project.dirs[index] : undefined;
    return dir || { notFound: `project "${id}" has no directory #${index}` };
  });
}
