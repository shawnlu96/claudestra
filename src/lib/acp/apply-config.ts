/** registry 钉住的模型 / 强度。新线程若拒绝配置，/clear 不可假装成功。 */
import type { AcpSession } from "./session.js";

export async function applyAcpLaunchConfig(s: AcpSession, model: string | undefined, effort: string | undefined, strict: boolean, log: (msg: string) => void): Promise<void> {
  for (const [id, v] of [["model", model], ["reasoning_effort", effort]] as const) {
    if (!v) continue;
    const r = await s.setConfig(id, v, strict ? 20_000 : 30_000);
    if (!r.ok) {
      if (strict) throw new Error(`新线程配置 ${id}=${v} 没生效：${r.error}`);
      log(`启动配置 ${id}=${v} 没生效：${r.error}`);
    }
  }
}
