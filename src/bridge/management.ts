/**
 * 管理按钮/菜单处理：直接执行 manager.ts，不经过 LLM
 */

import { TextChannel, type Client } from "discord.js";
import { MANAGER_PATH, ENV_WITH_BUN } from "./config.js";
import { typingIntervals } from "./components.js";
import { tmuxScreenshot } from "./screenshot.js";
import { buildComponents } from "./components.js";
import { discordReply } from "./discord-api.js";

export async function runManager(...args: string[]): Promise<any> {
  const proc = Bun.spawn(["bun", "run", MANAGER_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: ENV_WITH_BUN,
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out.trim());
  } catch {
    return { ok: false, error: out.trim() || "manager 执行失败" };
  }
}

export async function buildStatusPanel(): Promise<{
  text: string;
  components: any[];
}> {
  const result = await runManager("list");
  if (!result.ok) return { text: `❌ ${result.error}`, components: [] };
  const agents = result.agents || [];
  if (agents.length === 0)
    return {
      text: "📭 当前没有活跃的 Agent。",
      components: [
        {
          type: "buttons",
          buttons: [
            {
              id: "browse_sessions",
              label: "历史会话",
              emoji: "📋",
              style: "secondary",
            },
            {
              id: "create_agent",
              label: "新建 Agent",
              emoji: "➕",
              style: "success",
            },
            {
              id: "show_cron_menu",
              label: "定时任务",
              emoji: "⏰",
              style: "secondary",
            },
          ],
        },
      ],
    };
  const lines = agents.map((w: any) => {
    let status: string;
    if (w.status !== "active") {
      status = "💀 已断开";
    } else if (w.channelId && typingIntervals.has(w.channelId)) {
      status = "🔵 工作中";
    } else if (w.idle) {
      status = "🟢 空闲";
    } else {
      status = "🔵 执行中";
    }
    return `**${w.name}** — ${status}\n📁 \`${w.project}\``;
  });
  const activeAgents = agents.filter((w: any) => w.status === "active");
  const row1: any[] = [
    {
      id: "refresh_status",
      label: "刷新",
      emoji: "🔄",
      style: "primary",
    },
  ];
  if (activeAgents.length > 0) {
    row1.push(
      {
        id: "show_peek_menu",
        label: "监工",
        emoji: "👁",
        style: "secondary",
      },
      {
        id: "restart_all",
        label: "全部重启",
        emoji: "🔄",
        style: "secondary",
      },
      {
        id: "show_kill_menu",
        label: "销毁 Agent",
        emoji: "🗑",
        style: "danger",
      }
    );
  }
  const row2: any[] = [
    {
      id: "browse_sessions",
      label: "历史会话",
      emoji: "📋",
      style: "secondary",
    },
    {
      id: "create_agent",
      label: "新建 Agent",
      emoji: "➕",
      style: "success",
    },
    {
      id: "show_cron_menu",
      label: "定时任务",
      emoji: "⏰",
      style: "secondary",
    },
  ];
  return {
    text: "**📊 Agent 状态**\n\n" + lines.join("\n\n"),
    components: [
      { type: "buttons", buttons: row1 },
      { type: "buttons", buttons: row2 },
    ],
  };
}

export async function handleMgmtButton(
  id: string,
  chatId: string,
  messageId?: string,
  discord?: Client
): Promise<{ text: string; components?: any[] } | null> {
  if (id === "list_agents") {
    return await buildStatusPanel();
  }

  if (id === "refresh_status") {
    if (messageId && discord) {
      const panel = await buildStatusPanel();
      try {
        const ch = (await discord.channels.fetch(chatId)) as TextChannel;
        const msg = await ch.messages.fetch(messageId);
        await msg.edit({
          content: panel.text,
          components: panel.components
            ? buildComponents(panel.components)
            : [],
        });
      } catch { /* non-critical */ }
      return { text: "__HANDLED__" };
    }
    return await buildStatusPanel();
  }

  if (id === "show_kill_menu") {
    const result = await runManager("list");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const activeAgents = (result.agents || []).filter(
      (w: any) => w.status === "active"
    );
    if (activeAgents.length === 0)
      return { text: "📭 没有可销毁的 Agent。" };
    return {
      text: "**🗑 选择要销毁的 Agent：**",
      components: [
        {
          type: "select",
          id: "kill_agent",
          placeholder: "选择 Agent",
          options: activeAgents.map((w: any) => ({
            label: w.name,
            value: w.name.replace("agent-", ""),
          })),
        },
      ],
    };
  }

  if (id === "show_peek_menu") {
    const result = await runManager("list");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const activeAgents = (result.agents || []).filter(
      (w: any) => w.status === "active"
    );
    const options = [
      { label: "🎛 大总管 (master)", value: "master" },
      ...activeAgents.map((w: any) => ({
        label: w.name,
        value: w.name,
      })),
    ];
    return {
      text: "**👁 选择要查看的 Agent：**",
      components: [
        {
          type: "select",
          id: "peek_agent",
          placeholder: "选择 Agent",
          options,
        },
      ],
    };
  }

  if (id === "restart_all") {
    const result = await runManager("restart");
    if (!result.ok) return { text: `❌ ${result.error || "重启失败"}` };
    const msg = (result.results || [])
      .map((r: any) => `${r.name}: ${r.ok ? "✅" : `❌ ${r.error}`}`)
      .join("\n");
    return {
      text: `**🔄 重启结果**\n\n${msg}`,
      components: [
        {
          type: "buttons",
          buttons: [
            {
              id: "list_agents",
              label: "Agent 状态",
              emoji: "📊",
              style: "primary",
            },
          ],
        },
      ],
    };
  }

  if (id === "show_cron_menu") {
    const result = await runManager("cron-list");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const jobs = result.jobs || [];
    if (jobs.length === 0) {
      return {
        text: "📭 没有定时任务。\n\n通过大总管或命令行添加：\n`bun src/manager.ts cron-add <名称> \"<cron>\" <目录> <指令>`",
        components: [{
          type: "buttons",
          buttons: [
            { id: "list_agents", label: "Agent 状态", emoji: "📊", style: "primary" },
          ],
        }],
      };
    }
    const lines = jobs.map((j: any) => {
      const status = j.enabled ? "✅" : "⏸";
      const next = j.nextRun ? new Date(j.nextRun).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
      const last = j.lastRun ? new Date(j.lastRun).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "从未";
      return `${status} **${j.name}** — \`${j.schedule}\`\n📁 \`${j.dir}\`\n💬 ${j.prompt}\n-# 上次: ${last} · 下次: ${next}`;
    });

    const components: any[] = [];

    // 启用/暂停下拉菜单
    if (jobs.length > 0) {
      components.push({
        type: "select",
        id: "cron_toggle",
        placeholder: "⏯ 启用/暂停任务",
        options: jobs.map((j: any) => ({
          label: `${j.enabled ? "⏸ 暂停" : "▶ 启用"} ${j.name}`,
          value: j.name,
          description: j.schedule,
        })),
      });
    }

    // 删除下拉菜单
    if (jobs.length > 0) {
      components.push({
        type: "select",
        id: "cron_remove",
        placeholder: "🗑 删除任务",
        options: jobs.map((j: any) => ({
          label: j.name,
          value: j.name,
          description: j.schedule,
        })),
      });
    }

    // 底部按钮
    components.push({
      type: "buttons",
      buttons: [
        { id: "cron_history", label: "执行历史", emoji: "📜", style: "secondary" },
        { id: "list_agents", label: "Agent 状态", emoji: "📊", style: "primary" },
      ],
    });

    return {
      text: "**⏰ 定时任务**\n\n" + lines.join("\n\n"),
      components,
    };
  }

  if (id === "cron_history") {
    const result = await runManager("cron-history");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const records = result.records || [];
    if (records.length === 0) {
      return {
        text: "📭 没有执行记录。",
        components: [{
          type: "buttons",
          buttons: [
            { id: "show_cron_menu", label: "定时任务", emoji: "⏰", style: "primary" },
          ],
        }],
      };
    }
    const statusEmoji: Record<string, string> = {
      success: "✅", error: "❌", timeout: "⏰", running: "🔵",
    };
    const lines = records.slice(0, 10).map((r: any) => {
      const e = statusEmoji[r.status] || "❓";
      const time = new Date(r.startedAt).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai", hour12: false,
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      });
      return `${e} **${r.jobName}** — ${time}${r.error ? `\n-# ${r.error.slice(0, 100)}` : ""}`;
    });
    return {
      text: "**📜 执行历史**（最近 10 条）\n\n" + lines.join("\n\n"),
      components: [{
        type: "buttons",
        buttons: [
          { id: "show_cron_menu", label: "定时任务", emoji: "⏰", style: "primary" },
          { id: "list_agents", label: "Agent 状态", emoji: "📊", style: "secondary" },
        ],
      }],
    };
  }

  if (id === "browse_sessions") {
    const result = await runManager("sessions");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const sessions = (result.sessions || []).slice(0, 15);
    if (sessions.length === 0) return { text: "📭 没有找到历史会话。" };
    const lines = sessions.map(
      (s: any) =>
        `**${s.name}** — ${s.age}\n📁 \`${s.project}\`\n💬 ${s.lastMessage || "(无)"}`
    );
    const options = sessions.map((s: any) => ({
      label: s.name.slice(0, 100),
      value: s.sessionId,
      description: `${s.project} · ${s.age}`.slice(0, 100),
    }));
    return {
      text: "**📋 历史会话**\n\n" + lines.join("\n\n"),
      components: [
        {
          type: "select",
          id: "resume_session",
          placeholder: "📋 选择要恢复的会话",
          options,
        },
      ],
    };
  }

  return null;
}

export async function handleMgmtSelect(
  id: string,
  value: string,
  chatId: string,
  discord: Client
): Promise<{ text: string; components?: any[] } | null> {
  if (id === "kill_agent") {
    const result = await runManager("kill", value);
    if (!result.ok) return { text: `❌ ${result.error}` };
    return {
      text: `🗑️ \`${result.agent}\` 已销毁。`,
      components: [
        {
          type: "buttons",
          buttons: [
            {
              id: "list_agents",
              label: "Agent 状态",
              emoji: "📊",
              style: "primary",
            },
            {
              id: "browse_sessions",
              label: "历史会话",
              emoji: "📋",
              style: "secondary",
            },
            {
              id: "create_agent",
              label: "新建 Agent",
              emoji: "➕",
              style: "success",
            },
          ],
        },
      ],
    };
  }

  if (id === "cron_toggle") {
    const result = await runManager("cron-toggle", value);
    if (!result.ok) return { text: `❌ ${result.error}` };
    const emoji = result.enabled ? "▶" : "⏸";
    return {
      text: `${emoji} 定时任务 **${result.name}** 已${result.enabled ? "启用" : "暂停"}`,
      components: [{
        type: "buttons",
        buttons: [
          { id: "show_cron_menu", label: "定时任务", emoji: "⏰", style: "primary" },
        ],
      }],
    };
  }

  if (id === "cron_remove") {
    const result = await runManager("cron-remove", value);
    if (!result.ok) return { text: `❌ ${result.error}` };
    return {
      text: `🗑 定时任务 **${result.removed}** 已删除`,
      components: [{
        type: "buttons",
        buttons: [
          { id: "show_cron_menu", label: "定时任务", emoji: "⏰", style: "primary" },
        ],
      }],
    };
  }

  if (id === "peek_agent") {
    const windowName = value;
    const pngPath = await tmuxScreenshot(windowName);
    if (!pngPath) {
      return { text: `❌ 无法截取 \`${windowName}\` — 可能电脑锁屏了` };
    }
    const channel = (await discord.channels.fetch(chatId)) as TextChannel;
    await channel.send({
      content: `**👁 ${windowName} 终端截图**`,
      files: [{ attachment: pngPath }],
      components: buildComponents([
        {
          type: "buttons",
          buttons: [
            {
              id: "show_peek_menu",
              label: "再看一个",
              emoji: "👁",
              style: "primary",
            },
            {
              id: "list_agents",
              label: "Agent 状态",
              emoji: "📊",
              style: "secondary",
            },
          ],
        },
      ]),
    });
    return { text: "__HANDLED__" };
  }

  return null;
}
