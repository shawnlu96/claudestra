import { loadRegistry, saveRegistry, output } from "./core.js";

/**
 * `external <agent> on|off`：切换 registry 的 external 闸门（owner 2026-09-27，之前只能在 create 时带 --external）。
 * 关闭时同步把它从所有 peer token 的 scope 里摘掉——闸门关了还留在 scope 里就是两个数据源打架
 * （lib/peer-scope-gate.ts）；bridge 侧要求「正在共享时关闭须输入会话名确认」，这里不重复确认，CLI 直改。
 */
export async function cmdAgentExternal(name: string, mode: string) {
  if (!name || (mode !== "on" && mode !== "off")) {
    output({ ok: false, error: "external <agent> on|off" });
    return;
  }
  const bare = name.replace(/^agent-/, "");
  if (bare === "master") {
    output({ ok: false, error: "大总管不可标记 external（永不共享给 peer）" });
    return;
  }
  const reg = await loadRegistry();
  const key = reg.agents[`agent-${bare}`] ? `agent-${bare}` : reg.agents[bare] ? bare : null;
  if (!key) {
    output({ ok: false, error: `agent "${bare}" 不存在` });
    return;
  }
  const on = mode === "on";
  reg.agents[key].external = on;
  await saveRegistry(reg);
  let removedFromPeers: string[] = [];
  if (!on) {
    const { readPrincipals, writePrincipals } = await import("../lib/principals.js");
    const { dropAgentFromPeerScopes } = await import("../lib/peer-scope-gate.js");
    const file = await readPrincipals();
    removedFromPeers = dropAgentFromPeerScopes(file.principals, bare);
    if (removedFromPeers.length) await writePrincipals(file);
  }
  output({ ok: true, agent: bare, external: on, removedFromPeers });
}
