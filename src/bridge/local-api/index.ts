/**
 * bridge 本地 API（docs/design-hosted-frontend.md §13.2）：原 Next BFF 里「逻辑在服务端」的那批路由搬进 bridge，
 * 在 api-extensions.ts 登记、api-routes 鉴权之后被调。每个端点族一个模块，handler 返回 null = 不是我的路径。
 * 这里的路径在 api-routes 自己的路由**之前**匹配，所以只能精确匹配自己那几条，别用宽前缀。
 */
import type { Principal } from "../../lib/principals.js";
import { handleAccessPaths } from "./access.js";
import { handleAgentPrefs } from "./agent-prefs.js";
import { handleAttachments } from "./attachments.js";
import { handleClientLog } from "./client-log.js";
import { handleControl } from "./control.js";
import { handleHandoff } from "./handoff.js";
import { handleHost } from "./host.js";
import { handleMissionApi } from "./mission.js";
import { handleSettings } from "./settings.js";
import { handleSkillLibrary } from "./skills-library.js";
import { handleTranscribe } from "./transcribe.js";
import { versionResponse } from "./version.js";

/** GET /api/v1/capabilities 的 features 里报的名字（前端按名字判某能力在不在） */
export const LOCAL_API_FEATURES = ["version", "settings", "profile", "agent-settings", "hidden-messages", "skill-prefs", "transcribe", "client-log", "host-open", "attachments", "control", "handoff", "mission", "access-paths", "skill-library"];

type Family = (req: Request, path: string, principal: Principal, url: URL) => Promise<Response | null> | Response | null;
const FAMILIES: Family[] = [handleSettings, handleAgentPrefs, handleTranscribe, handleClientLog, handleHost, handleAttachments, handleControl, handleHandoff, handleMissionApi, handleAccessPaths, handleSkillLibrary];

export async function handleLocalApi(req: Request, url: URL, principal: Principal): Promise<Response | null> {
  const path = url.pathname.slice("/api/v1".length);
  if (path === "/version" && req.method === "GET") return versionResponse();
  for (const family of FAMILIES) {
    const r = await family(req, path, principal, url);
    if (r) return r;
  }
  return null;
}
