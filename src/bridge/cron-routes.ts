/**
 * /api/v1/cron*（从 api-routes 拆出：那个文件只许变小）。列表 / 删除：全权凭据（isFullScope）。
 * 新建 / 编辑 / 开关（重新启用）会让 prompt 到点原样敲进目标 agent 的 TUI（src/cron.ts，不带来源头），和斜杠直通同一类，所以要求：
 * 全权（isFullScope，要求 scope 含 "*"）之外还要 owner 本人（isOwnerPrincipal）；有 targetAgent 时它还得在 scope 里——
 * "*" 不含 master（任何写法），要显式列出（inScopeEitherName）。测试见 tests/cron-create-gates.test.ts。
 * runManager / loadJobs 由调用方注入：一个在 management.ts（hub），一个在 src/cron.ts（入口），bridge 模块都不能 import。
 */
import { isOwnerPrincipal, type Principal } from "../lib/principals.js";
import { firstFlagLikeField, textFieldsProblem } from "../lib/flag-like.js";
import type { CronJob } from "../lib/cron-job.js";
import { apiJson, forbidden, inScopeEitherName, invalidJsonBody, INVALID_JSON, isFullScope, notInScope, readJsonBody } from "./api-respond.js";

export interface CronRouteDeps {
  runManager: (...args: string[]) => Promise<any>;
  loadJobs: () => Promise<CronJob[]>;
}

const CRON_OWNER_ONLY = "creating, editing or toggling cron jobs requires the owner's own credential";
const cronResult = (r: any): Response => apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });

/** 新建 / 编辑 / 开关的身份门（读 body 之前；scope 含 "*" 已由外层 isFullScope 保证）：不放行 → 403 响应，放行 → null */
const cronWriterDenied = (principal: Principal): Response | null => (isOwnerPrincipal(principal) ? null : forbidden(CRON_OWNER_ONLY));

/** prompt 会敲进去的那个 agent（空 = 临时 agent）要在 scope 里："*" 不含 master（任何写法，inScopeEitherName → isMasterName）。按 src/cron.ts 的解析补成 agent-<名> 再判 */
const targetDenied = (principal: Principal, target: string | null | undefined): Response | null =>
  target && !inScopeEitherName(principal, target.startsWith("agent-") ? target : `agent-${target}`) ? notInScope(target) : null;

/**
 * body 的入口闸：类型 / 控制字符（textFieldsProblem，先于 trim）；透传给 manager 的值不许以 "-" 开头（trim 之后看，与实际传过去的
 * 一致）——manager 的 cron-add 在整个 argv 里找 --target-agent / --channel，project 写成 "--target-agent" 就能绕过 targetDenied
 * （reviews/T32-adv5.md P2-1）。不放行 → 400 响应，放行 → null
 */
const CRON_ARG_FIELDS = ["name", "schedule", "prompt", "dir", "effort", "project", "targetAgent"];
function cronBodyDenied(body: any): Response | null {
  const textBad = textFieldsProblem(body);
  if (textBad) return apiJson(400, textBad);
  const f = firstFlagLikeField(Object.fromEntries(CRON_ARG_FIELDS.filter((k) => typeof body?.[k] === "string").map((k) => [k, body[k].trim()])));
  return f ? apiJson(400, { ok: false, code: "flag_like", field: f, error: `「${f}」不能以 "-" 开头 / "${f}" must not start with "-"` }) : null;
}

export async function handleCronRoutes(req: Request, path: string, principal: Principal, deps: CronRouteDeps): Promise<Response | null> {
  if (path !== "/cron" && !path.startsWith("/cron/")) return null;
  if (!isFullScope(principal)) return forbidden("cron management requires a full-scope token");
  if (path === "/cron" && req.method === "GET") {
    const jobs = await deps.loadJobs();
    return apiJson(200, {
      ok: true,
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        schedule: j.schedule,
        dir: j.dir.replace(process.env.HOME || "", "~"),
        prompt: j.prompt, // 全文——编辑界面要用,不像 cron-list 截 80
        enabled: j.enabled,
        lastRun: j.lastRun ?? null,
        nextRun: j.nextRun ?? null,
        targetAgent: j.targetAgent ?? null,
        effort: j.effort ?? null, // null = 缺省(临时 agent 走 medium)
        project: j.project ?? null, // null = 按 dir 自动解析
        createdAt: j.createdAt,
      })),
    });
  }
  if (path === "/cron" && req.method === "POST") {
    const writer = cronWriterDenied(principal);
    if (writer) return writer;
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const bad = cronBodyDenied(body);
    if (bad) return bad;
    const target = targetDenied(principal, body?.targetAgent);
    if (target) return target;
    const name = String(body?.name ?? "").trim();
    const schedule = String(body?.schedule ?? "").trim();
    const prompt = String(body?.prompt ?? "").trim();
    const dir = String(body?.dir ?? "~").trim() || "~";
    if (!name || !schedule || !prompt) {
      return apiJson(400, { ok: false, error: "name/schedule/prompt required" });
    }
    const extra: string[] = body?.targetAgent ? ["--target-agent", String(body.targetAgent)] : [];
    if (body?.effort) extra.push("--effort", String(body.effort));
    if (body?.project) extra.push("--project", String(body.project));
    return cronResult(await deps.runManager("cron-add", name, schedule, dir, ...extra, prompt));
  }
  const cronAction = path.match(/^\/cron\/([^/]+)\/(toggle|remove|edit)$/);
  if (cronAction && req.method === "POST") {
    const id = decodeURIComponent(cronAction[1]);
    const action = cronAction[2];
    let r: any;
    if (action === "remove") r = await deps.runManager("cron-remove", id);
    else {
      const writer = cronWriterDenied(principal);
      if (writer) return writer;
      // 开关（重新启用）和编辑都会让 prompt 再敲进目标 agent。编辑改不了 targetAgent：比的是原任务的（找不到任务就交给 manager 回「找不到」）
      const job = (await deps.loadJobs()).find((j) => j.name === id || j.id === id);
      const target = targetDenied(principal, job?.targetAgent);
      if (target) return target;
      if (action === "toggle") return cronResult(await deps.runManager("cron-toggle", id));
      const body: any = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      const bad = cronBodyDenied(body);
      if (bad) return bad;
      const flags: string[] = [];
      if (body?.schedule) flags.push("--schedule", String(body.schedule));
      if (body?.prompt) flags.push("--prompt", String(body.prompt));
      if (body?.name) flags.push("--name", String(body.name));
      if (body?.dir) flags.push("--dir", String(body.dir));
      if (body?.effort) flags.push("--effort", String(body.effort));
      // project: 传 "" / null 表示清除(回到按 dir 解析),manager 侧用 "-" 表示
      if (body?.project !== undefined) flags.push("--project", body.project ? String(body.project) : "-");
      if (!flags.length) return apiJson(400, { ok: false, error: "nothing to edit" });
      r = await deps.runManager("cron-edit", id, ...flags);
    }
    return cronResult(r);
  }
  return apiJson(405, { ok: false, error: "method not allowed" });
}
