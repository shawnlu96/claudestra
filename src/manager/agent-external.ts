import { loadRegistry, saveRegistry, output, type Registry } from "./core.js";

/** 按裸名 / 带前缀名找 registry 条目；找不到就 output 错误并返回 null（两个命令共用） */
async function findAgent(bare: string): Promise<{ reg: Registry; key: string } | null> {
  const reg = await loadRegistry();
  const key = reg.agents[`agent-${bare}`] ? `agent-${bare}` : reg.agents[bare] ? bare : null;
  if (!key) output({ ok: false, error: `agent "${bare}" 不存在` });
  return key ? { reg, key } : null;
}

/** `label <agent> [text]`：设 / 清「显示名」（registry label，owner 2026-09-27）。空文本 = 清除；≤40 字符，去首尾空白。 */
export async function cmdAgentLabel(name: string, text: string) {
  const bare = name.replace(/^agent-/, "");
  if (!bare) {
    output({ ok: false, error: "label <agent> [text]" });
    return;
  }
  const label = text.trim();
  if (label.length > 40) {
    output({ ok: false, error: "显示名最多 40 个字符" });
    return;
  }
  const hit = await findAgent(bare);
  if (!hit) return;
  const { reg, key } = hit;
  if (label) reg.agents[key].label = label;
  else delete reg.agents[key].label;
  await saveRegistry(reg);
  output({ ok: true, agent: bare, label: label || null });
}

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
  const hit = await findAgent(bare);
  if (!hit) return;
  const { reg, key } = hit;
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
