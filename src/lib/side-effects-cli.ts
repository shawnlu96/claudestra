/**
 * lib/side-effects.ts 的对外命令表：云 / 集群 / 基础设施 CLI，以及发布、部署、数据库客户端。这些命令改的是生产资源或别人看得见的东西，
 * 收不回，所以只放行查看类（白名单），其余判对外——动词列不全，漏一个就是把删库判成只读。单测 tests/side-effects.test.ts。
 */
import type { SideEffect, SideEffectVerdict } from "./side-effects.js";

const v = (kind: SideEffect, hint?: string): SideEffectVerdict => (hint ? { kind, hint } : { kind });
const ext = (hint: string) => v("external", hint);

/** gcloud / az 的查看动词（get-iam-policy、list-tags 这类带后缀的也算） */
const CLOUD_READ = /^(describe|list|get|ls|show|help|version|wait)(-|$)/;
/** gcloud / az 的写动词：命令路径上先碰到它就是写（触发任务、调用函数、发消息、部署都在这里） */
const CLOUD_WRITE = new RegExp(
  "^(delete|remove|create|update|set|unset|deploy|resize|start|stop|restart|reset|deallocate|scale|apply|import|export|add|run|call|invoke|publish|submit"
  + "|patch|move|pause|resume|suspend|enable|disable|execute|cancel|rollback|promote|attach|detach|ssh|scp|cp|copy|mv|rm|sync|upload|config-zip)(-|$)",
);

/**
 * gcloud / az 只看命令路径（第一个选项之前的那串词）：跳过顶层命令组（gcloud run services list 的 run 是组名），
 * 路径上第一个认得的动词是查看动词才算只读。选项值（--message list）和动词后面的资源名（jobs run get-prices-job）都不看。
 */
function cloudPathReads(t: string[]): boolean {
  const path: string[] = [];
  for (const a of t.slice(1)) {
    if (a.startsWith("-")) break;
    path.push(a);
  }
  const verb = path.slice(1).find((w) => CLOUD_READ.test(w) || CLOUD_WRITE.test(w));
  return !!verb && CLOUD_READ.test(verb) && !CLOUD_WRITE.test(verb);
}

/** 云 / 集群 / 基础设施命令；不是这类命令返回 null */
export function classifyCloud(t: string[]): SideEffectVerdict | null {
  const [c0 = "", c1 = "", c2 = ""] = t;
  const verbs = t.slice(1).filter((a) => !a.startsWith("-"));
  if (c0 === "kubectl") {
    // auth / config 不是整组只读：auth reconcile 改集群 RBAC，config use-context 改本机 kubeconfig
    if (c1 === "auth") return /^(can-i|whoami)$/.test(c2) ? v("none") : ext("RBAC 可能已经改了，先 kubectl auth can-i / get 核对");
    if (c1 === "config") return /^(view|current-context|get-.+)$/.test(c2) ? v("none") : v("check_first", "kubeconfig 可能已经改了，先 kubectl config current-context 核对");
    if (/^(get|describe|logs|top|explain|version|api-resources)$/.test(c1)) return v("none");
    return ext("集群资源可能已经改了，先 kubectl get 核对现状");
  }
  if (c0 === "helm") return /^(list|ls|status|get|show|history|search|template|lint)$/.test(c1) ? v("none") : ext("release 可能已经变了，先 helm status 核对");
  if (c0 === "terraform" || c0 === "tofu") {
    if (/^(plan|show|output|validate|version|providers|graph|console)$/.test(c1) || /^(state|workspace)$/.test(c1) && /^(list|show)$/.test(c2)) return v("none");
    if (c1 === "init" || c1 === "fmt") return c1 === "fmt" && !t.includes("-check") ? v("check_first", "fmt 会改文件，先看文件现状") : v("idempotent");
    return ext("基础设施可能已经改了一半，先 plan 看现状，别直接重跑");
  }
  if (c0 === "aws" || c0 === "gcloud" || c0 === "az") {
    // aws 的操作名固定在第二个词（aws <服务> <操作>）；gcloud / az 的命令组长短不一，按命令路径判
    const ok = c0 === "aws" ? CLOUD_READ.test(verbs[1] ?? "") || verbs[0] === "sts" && /^get-/.test(verbs[1] ?? "") : cloudPathReads(t);
    return ok ? v("none") : ext("云资源可能已经改了，先 describe / list 核对，别直接重跑");
  }
  return null;
}

const PUBLISHED = "可能已经发布 / 部署了，先查线上版本和部署记录，别直接重跑";
const SQL_WRITE = /\b(drop|delete|update|insert|upsert|truncate|alter|create|grant|revoke|merge|replace|copy)\b/i;
const REDIS_WRITE = /^(flushall|flushdb|del|unlink|set|setex|mset|hset|hdel|lpush|rpush|lpop|rpop|sadd|srem|zadd|zrem|expire|rename|incr|decr|config|shutdown|eval|publish)$/i;

/** 发布、部署、数据库客户端；不是这类命令返回 null */
export function classifyPublish(t: string[]): SideEffectVerdict | null {
  const [c0 = "", c1 = "", c2 = ""] = t;
  const has = (re: RegExp) => t.slice(1).some((x) => re.test(x));
  if (["npm", "bun", "yarn", "pnpm"].includes(c0)) {
    if (/^(publish|unpublish|dist-tag|deprecate|push)$/.test(c1) || c1 === "npm" && /^(publish|tag)$/.test(c2)) return ext(PUBLISHED);
    return null;
  }
  if (c0 === "docker") return c1 === "push" || c2 === "push" || has(/^--push$/) ? ext(PUBLISHED) : null; // docker image push、buildx build --push
  if (c0 === "cargo" && c1 === "publish" || c0 === "twine" && c1 === "upload" || c0 === "gem" && c1 === "push" || c0 === "poetry" && c1 === "publish") return ext(PUBLISHED);
  if (/^(fly|flyctl|wrangler|firebase|netlify|cdk|serverless|sls)$/.test(c0) && /^(deploy|publish|destroy|remove)$/.test(c1)) return ext(PUBLISHED);
  if (c0 === "pulumi" && /^(up|update|destroy)$/.test(c1)) return ext(PUBLISHED);
  if (c0 === "vercel") return has(/^--prod$/) || /^(deploy|promote|rollback|alias|remove|rm)$/.test(c1) ? ext(PUBLISHED) : v("check_first", "可能已经部署了预览版，先 vercel ls 核对");
  if (/^(psql|mysql|sqlite3|mongosh|mongo)$/.test(c0)) {
    return SQL_WRITE.test(t.slice(1).join(" ")) ? ext("语句可能已经执行（写语句收不回），先查数据现状，别直接重跑") : v("check_first", "先查数据现状再重来");
  }
  if (c0 === "redis-cli") return has(REDIS_WRITE) ? ext("写命令可能已经执行，先查数据现状，别直接重跑") : v("check_first", "先查数据现状再重来");
  return null;
}
