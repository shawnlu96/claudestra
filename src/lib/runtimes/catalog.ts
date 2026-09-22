/**
 * 可建 agent 的运行时清单（bridge GET /api/v1/runtimes 的返回体）。
 *
 * 新建 agent 的运行时下拉读它：available=false 的前端不显示（没装 codex 的人无感）。
 * available() 由各适配器自己缓存（Codex 5 分钟），这里不再加一层。hint 里可能带本机
 * 路径——端点只给全权 token，BFF 也只往浏览器转 id / label / available。
 */
import { managedFor, manageableRuntimeIds } from "./index.js";

export interface RuntimeCatalogEntry {
  id: string;
  label: string;
  manageable: true;
  available: boolean;
  hint?: string;
}

export async function runtimeCatalog(): Promise<RuntimeCatalogEntry[]> {
  return Promise.all(
    manageableRuntimeIds().map(async (id) => {
      const a = managedFor(id)!;
      const r = await a.available().catch((e) => ({ ok: false as const, hint: (e as Error).message }));
      return { id, label: a.label, manageable: true as const, available: r.ok, ...(r.ok ? {} : { hint: r.hint }) };
    }),
  );
}
