/**
 * /api/v1 的扩展路由登记处：api-routes.ts（guard 基线里只许缩）在鉴权之后调一次 handleExtensionRoutes，
 * 新的端点族（推送 bridge/push/、本地 API bridge/local-api/）把自己的 handler 加进 EXTENSIONS，不再往 hub 里加行。
 * handler 返回 null = 不是我的路径；数组顺序即优先级；异常由 serveApiRequest 统一转成 JSON 错误。
 */
import type { Principal } from "../lib/principals.js";
import { handleLocalApi, LOCAL_API_FEATURES } from "./local-api/index.js";
import { API_VERSION } from "./local-api/version.js";

type ExtensionHandler = (req: Request, url: URL, principal: Principal) => Promise<Response | null> | Response | null;

/** 端点族在这里登记（import 它的 handler 后加进数组） */
const EXTENSIONS: ExtensionHandler[] = [handleLocalApi];

/** GET /api/v1/capabilities 附带的 apiVersion / features：各端点族把自己的名字并进来，前端按名字判能力 */
export function apiFeatures(): { apiVersion: number; features: string[] } {
  return { apiVersion: API_VERSION, features: [...LOCAL_API_FEATURES] };
}

export async function handleExtensionRoutes(req: Request, url: URL, principal: Principal): Promise<Response | null> {
  for (const h of EXTENSIONS) {
    const r = await h(req, url, principal);
    if (r) return r;
  }
  return null;
}
