/**
 * 权限预设管理命令（permissions / perm / perms）。
 *
 * 从 manager.ts 逐字搬出（函数体未改，只加 export / 改相对路径）。
 */
import { AGENT_PREFIX } from "../lib/tmux-helper.js";
import { listPresets, isKnownPreset, DISALLOWED_PRESETS, DEFAULT_PRESET } from "../lib/claude-launch.js";
import { type AgentInfo, loadRegistry, saveRegistry, normalizeName, output, extractPermFlags } from "./core.js";

// ============================================================
// 权限管理
// ============================================================

function describePerm(info: AgentInfo): {
  preset: string;
  raw?: string;
  tools: string[];
} {
  if (info.disallowedRaw) {
    return {
      preset: "(custom)",
      raw: info.disallowedRaw,
      tools: info.disallowedRaw.trim().split(/\s+/).filter(Boolean),
    };
  }
  const preset = info.disallowedPreset || DEFAULT_PRESET;
  return {
    preset,
    tools: [...(DISALLOWED_PRESETS[preset] || [])],
  };
}

export async function cmdPermissions(sub: string, ...rest: string[]) {
  if (!sub || sub === "list") {
    // 列出所有 agent 的权限
    const reg = await loadRegistry();
    const rows = Object.entries(reg.agents)
      .filter(([, info]) => info.status === "active")
      .map(([name, info]) => {
        const d = describePerm(info);
        return { name, preset: d.preset, toolCount: d.tools.length };
      });
    output({ ok: true, agents: rows });
    return;
  }

  if (sub === "presets") {
    const presets = listPresets().map((name) => ({
      name,
      toolCount: DISALLOWED_PRESETS[name].length,
      tools: [...DISALLOWED_PRESETS[name]],
    }));
    output({ ok: true, presets, default: DEFAULT_PRESET });
    return;
  }

  if (sub === "get") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "usage: permissions get <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    const d = describePerm(info);
    output({
      ok: true,
      agent: tmuxName,
      preset: d.preset,
      disallowedRaw: d.raw,
      tools: d.tools,
    });
    return;
  }

  if (sub === "set") {
    // permissions set <name> --preset <name>
    // permissions set <name> --disallowed "..."
    const [name] = rest;
    if (!name) {
      output({
        ok: false,
        error: 'usage: permissions set <name> --preset <preset> | --disallowed "..."',
      });
      return;
    }
    const { preset, disallowedRaw } = extractPermFlags(rest.slice(1));
    if (!preset && !disallowedRaw) {
      output({
        ok: false,
        error: '需要指定 --preset 或 --disallowed。可用 preset: ' + listPresets().join(", "),
      });
      return;
    }
    if (preset && !isKnownPreset(preset)) {
      output({
        ok: false,
        error: `未知预设: "${preset}"。可用: ${listPresets().join(", ")}`,
      });
      return;
    }

    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    info.disallowedPreset = preset;
    info.disallowedRaw = disallowedRaw;
    await saveRegistry(reg);

    const d = describePerm(info);
    output({
      ok: true,
      agent: tmuxName,
      preset: d.preset,
      disallowedRaw: d.raw,
      tools: d.tools,
      hint: `新配置已写入 registry。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
    });
    return;
  }

  if (sub === "reset") {
    const [name] = rest;
    if (!name) {
      output({ ok: false, error: "usage: permissions reset <name>" });
      return;
    }
    const tmuxName = normalizeName(name);
    const reg = await loadRegistry();
    const info = reg.agents[tmuxName];
    if (!info) {
      output({ ok: false, error: `找不到 agent: ${tmuxName}` });
      return;
    }
    info.disallowedPreset = undefined;
    info.disallowedRaw = undefined;
    await saveRegistry(reg);
    output({
      ok: true,
      agent: tmuxName,
      preset: DEFAULT_PRESET,
      hint: `已重置为默认预设。要让 ${tmuxName} 立即生效，跑: bun src/manager.ts restart ${tmuxName.replace(AGENT_PREFIX, "")}`,
    });
    return;
  }

  output({
    ok: false,
    error: `未知子命令: permissions ${sub}`,
    usage: [
      "permissions list                 — list every agent's permission preset",
      "permissions presets              — list available presets及其包含的工具",
      "permissions get <name>           — show one agent's permissions in detail",
      'permissions set <name> --preset <preset>｜--disallowed "..."',
      "permissions reset <name>         — reset to the default preset",
    ],
  });
}
