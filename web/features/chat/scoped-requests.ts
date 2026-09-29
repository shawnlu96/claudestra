/**
 * 后台自动发、接口又要全权的请求（已读回执 POST /agents/:name/read、项目列表 GET /projects）：判定过不是全权的设备
 * （guest / 部分 scope，contacts-data.fullScopeNow() === false）就不发，免得每次打开会话、每轮轮询都吃一个 403。
 * 还没判定（null）时照发——宁可 guest 开头多一个 403，也不让 owner 首屏丢项目分组。
 */
import { markRead as apiMarkRead } from "@/lib/api/push";
import { projectsList as apiProjectsList } from "@/lib/api/system";
import { fullScopeNow } from "./contacts-data";

export function markRead(agent: string): Promise<void> {
  return fullScopeNow() === false ? Promise.resolve() : apiMarkRead(agent);
}

/** 不发时回 { ok: false }：调用方（chat-store.loadProjects）按「没拿到」处理，分组渲染本来就对缺 projects 有兜底 */
export function projectsList<T>(): Promise<T> {
  return fullScopeNow() === false ? Promise.resolve({ ok: false } as T) : apiProjectsList<T>();
}
