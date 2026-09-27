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
  let stillSharedWith: string[] = [];
  if (!on) {
    const { readPrincipals, writePrincipals } = await import("../lib/principals.js");
    const { dropAgentFromPeerScopes, peersSharingAgent } = await import("../lib/peer-scope-gate.js");
    const file = await readPrincipals();
    removedFromPeers = dropAgentFromPeerScopes(file.principals, bare);
    if (removedFromPeers.length) await writePrincipals(file);
    // 持有全量 "*" 授权的历史 peer token 没有可摘的名字，闸门关了它照样能访问：如实报出来，
    // 前端据此提示去 Peer 面板改那条 scope——不然「已关闭」会造成安全错觉
    stillSharedWith = peersSharingAgent(file.principals, bare);
  }
  output({ ok: true, agent: bare, external: on, removedFromPeers, stillSharedWith });
}
