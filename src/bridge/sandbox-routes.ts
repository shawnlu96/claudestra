/**
 * 沙箱 bridge 的 /api/v1 拒绝表（登记在 api-extensions.ts 的最前面，先于所有端点族匹配）。
 *
 * 沙箱与生产共用 ~/.claude 和本机 launchd，而沙箱只认得自己的 registry——生产 agent 的会话在它眼里
 * 都是「未纳管」。所以下面这些会写 ~/.claude、动生产会话 / bg job、reload daemon 或对外联网的端点
 * 在沙箱里一律 403。非沙箱时 handler 直接返回 null，路由行为不变。
 */
import { sandboxDisabled } from "../lib/sandbox.js";
import { apiJson } from "./api-respond.js";

interface Rule {
  method?: string;
  path: RegExp;
  feature: string;
}

const RULES: Rule[] = [
  { method: "PUT", path: /^\/config\/claude-defaults$/, feature: "改全局 ~/.claude/settings.json" },
  { method: "POST", path: /^\/sessions\/[^/]+\/(manage|cleanup|adopt)$/, feature: "归档 / 删除 / 清理 / 收编会话" },
  { method: "POST", path: /^\/agents\/resume$/, feature: "按会话 id 恢复（可能抢生产会话）" },
  { method: "POST", path: /^\/agents\/[^/]+\/pi-update$/, feature: "pi update（全局 npm 安装）" },
  { method: "POST", path: /^\/restart-all$/, feature: "全体重启（含大总管）" },
  { path: /^\/update(\/.*)?$/, feature: "升级与更新检查（git pull / reload daemon / GitHub API）" },
  { path: /^\/peers(\/.*)?$/, feature: "跨实例 peer" },
];

/** 命中拒绝表的规则（纯函数，tests/sandbox.test.ts）；path 是去掉 /api/v1 前缀后的部分 */
export function sandboxDeniedRoute(method: string, path: string): string | null {
  const r = RULES.find((x) => (!x.method || x.method === method) && x.path.test(path));
  return r ? r.feature : null;
}

export function sandboxRouteGate(req: Request, url: URL): Response | null {
  const feature = sandboxDeniedRoute(req.method, url.pathname.replace(/^\/api\/v1/, ""));
  const off = feature ? sandboxDisabled(feature) : null;
  return off ? apiJson(403, { ok: false, error: off, sandbox: true }) : null;
}
