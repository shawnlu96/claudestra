/**
 * 管理按钮/菜单处理：直接执行 manager.ts，不经过 LLM
 */

import { TextChannel, type Client } from "discord.js";
import { MANAGER_PATH, TMUX_SOCK, ENV_WITH_BUN } from "./config.js";
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
  const workers = result.workers || [];
  if (workers.length === 0)
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
              id: "create_worker",
              label: "新建 Agent",
              emoji: "➕",
              style: "success",
            },
          ],
        },
      ],
    };
  const lines = workers.map((w: any) => {
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
  const activeWorkers = workers.filter((w: any) => w.status === "active");
  const row1: any[] = [
    {
      id: "refresh_status",
      label: "刷新",
      emoji: "🔄",
      style: "primary",
    },
  ];
  if (activeWorkers.length > 0) {
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
      id: "create_worker",
      label: "新建 Agent",
      emoji: "➕",
      style: "success",
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
  if (id === "list_workers") {
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
    const activeWorkers = (result.workers || []).filter(
      (w: any) => w.status === "active"
    );
    if (activeWorkers.length === 0)
      return { text: "📭 没有可销毁的 Agent。" };
    return {
      text: "**🗑 选择要销毁的 Agent：**",
      components: [
        {
          type: "select",
          id: "kill_worker",
          placeholder: "选择 Agent",
          options: activeWorkers.map((w: any) => ({
            label: w.name,
            value: w.name.replace("worker-", ""),
          })),
        },
      ],
    };
  }

  if (id === "show_peek_menu") {
    const result = await runManager("list");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const activeWorkers = (result.workers || []).filter(
      (w: any) => w.status === "active"
    );
    const options = [
      { label: "🎛 大总管 (master)", value: "master" },
      ...activeWorkers.map((w: any) => ({
        label: w.name,
        value: w.name,
      })),
    ];
    return {
      text: "**👁 选择要查看的 Agent：**",
      components: [
        {
          type: "select",
          id: "peek_worker",
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
              id: "list_workers",
              label: "Agent 状态",
              emoji: "📊",
              style: "primary",
            },
          ],
        },
      ],
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
  if (id === "kill_worker") {
    const result = await runManager("kill", value);
    if (!result.ok) return { text: `❌ ${result.error}` };
    return {
      text: `🗑️ \`${result.worker}\` 已销毁。`,
      components: [
        {
          type: "buttons",
          buttons: [
            {
              id: "list_workers",
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
              id: "create_worker",
              label: "新建 Agent",
              emoji: "➕",
              style: "success",
            },
          ],
        },
      ],
    };
  }

  if (id === "peek_worker") {
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
              id: "list_workers",
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
