import {
  Client,
  GatewayIntentBits,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { $ } from "bun";
import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// ============================================================
// 配置
// ============================================================

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID = process.env.DISCORD_GUILD_ID!;
const SOCK = process.env.TMUX_SOCK || "/tmp/claude-orchestrator/master.sock";
const REGISTRY_PATH =
  process.env.REGISTRY_PATH ||
  `${process.env.HOME}/.claude-orchestrator/registry.json`;
const CONTROL_CHANNEL = "control";
const WORKER_PREFIX = "worker-";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 180_000;
const DISCORD_MAX_LEN = 1900;

// ============================================================
// Registry — 持久化 worker 状态
// ============================================================

interface WorkerInfo {
  project: string;
  purpose: string;
  created: string;
  status: "active" | "stopped";
  channelId?: string;
  notes: string;
  sessionId?: string;
  cwd?: string;
}

interface Registry {
  socket: string;
  workers: Record<string, WorkerInfo>;
}

async function loadRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) {
    const empty: Registry = { socket: SOCK, workers: {} };
    await saveRegistry(empty);
    return empty;
  }
  return JSON.parse(await readFile(REGISTRY_PATH, "utf-8"));
}

async function saveRegistry(reg: Registry) {
  await mkdir(`${process.env.HOME}/.claude-orchestrator`, { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

// ============================================================
// tmux 工具函数
// ============================================================

async function tmuxRaw(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", "-S", SOCK, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function ensureSocket() {
  await $`mkdir -p /tmp/claude-orchestrator`.quiet();
}

async function listSessions(): Promise<string[]> {
  const out = await tmuxRaw(["list-sessions", "-F", "#{session_name}"]);
  if (!out) return [];
  return out.split("\n").filter((s) => s.startsWith(WORKER_PREFIX));
}

async function sessionExists(name: string): Promise<boolean> {
  const sessions = await listSessions();
  return sessions.includes(name);
}

async function captureLast(name: string, lines = 80): Promise<string> {
  return tmuxRaw(["capture-pane", "-t", name, "-p", "-J", "-S", `-${lines}`]);
}

async function isWorkerIdle(name: string): Promise<boolean> {
  const tail = await tmuxRaw(["capture-pane", "-t", name, "-p"]);
  const last5 = tail.split("\n").slice(-5).join("\n");
  return /❯/.test(last5);
}

async function sendToWorker(name: string, message: string) {
  await tmuxRaw(["send-keys", "-t", name, "-l", "--", message]);
  await Bun.sleep(100);
  await tmuxRaw(["send-keys", "-t", name, "Enter"]);
}

async function createWorkerSession(
  name: string,
  dir: string,
  sessionId?: string
): Promise<boolean> {
  await ensureSocket();
  await tmuxRaw(["new-session", "-d", "-s", name, "-c", dir]);
  await Bun.sleep(500);
  const sessionFlag = sessionId ? ` --session-id ${sessionId}` : "";
  await tmuxRaw([
    "send-keys",
    "-t",
    name,
    "-l",
    "--",
    `claude${sessionFlag} --dangerously-skip-permissions`,
  ]);
  await Bun.sleep(100);
  await tmuxRaw(["send-keys", "-t", name, "Enter"]);
  for (let i = 0; i < 15; i++) {
    await Bun.sleep(1000);
    if (await isWorkerIdle(name)) return true;
  }
  return await sessionExists(name);
}

async function killWorkerSession(name: string) {
  await tmuxRaw(["kill-session", "-t", name]);
}

// ============================================================
// Claude Code Session 扫描
// ============================================================

interface ClaudeSession {
  sessionId: string;
  cwd: string;
  slug: string;
  timestamp: string;
  modifiedAt: Date;
  filePath: string;
  version: string;
}

let lastSessionsList: ClaudeSession[] = [];

async function scanClaudeSessions(
  search?: string
): Promise<ClaudeSession[]> {
  const projectsDir = join(process.env.HOME || "~", ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  const sessions: ClaudeSession[] = [];
  const projectDirs = await readdir(projectsDir);

  for (const projDir of projectDirs) {
    const projPath = join(projectsDir, projDir);
    const projStat = await stat(projPath).catch(() => null);
    if (!projStat?.isDirectory()) continue;

    const files = await readdir(projPath);
    for (const file of files) {
      if (!file.endsWith(".jsonl") || file.includes("compact")) continue;
      const uuid = file.replace(".jsonl", "");
      if (!/^[0-9a-f]{8}-/.test(uuid)) continue;

      const filePath = join(projPath, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) continue;

      try {
        const fd = Bun.file(filePath);
        const chunk = await fd.slice(0, 8192).text();
        const lines = chunk.split("\n").filter((l) => l.trim());

        let sessionId = uuid;
        let cwd = "";
        let slug = "";
        let timestamp = "";
        let version = "";

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.sessionId) sessionId = obj.sessionId;
            if (obj.cwd && !cwd) cwd = obj.cwd;
            if (obj.slug && !slug) slug = obj.slug;
            if (obj.timestamp && !timestamp) timestamp = obj.timestamp;
            if (obj.version && !version) version = obj.version;
            if (cwd && slug) break;
          } catch {}
        }

        if (!cwd) continue;

        if (search) {
          const q = search.toLowerCase();
          const haystack = `${cwd} ${slug} ${sessionId}`.toLowerCase();
          if (!haystack.includes(q)) continue;
        }

        sessions.push({
          sessionId,
          cwd,
          slug,
          timestamp,
          modifiedAt: fileStat.mtime,
          filePath,
          version,
        });
      } catch {}
    }
  }

  sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return sessions;
}

async function resumeWorkerSession(
  name: string,
  dir: string,
  sessionId: string,
  displayName?: string
): Promise<boolean> {
  await ensureSocket();
  await tmuxRaw(["new-session", "-d", "-s", name, "-c", dir]);
  await Bun.sleep(500);
  const nameFlag = displayName ? ` --name "${displayName}"` : "";
  await tmuxRaw([
    "send-keys",
    "-t",
    name,
    "-l",
    "--",
    `claude --resume ${sessionId}${nameFlag} --dangerously-skip-permissions`,
  ]);
  await Bun.sleep(100);
  await tmuxRaw(["send-keys", "-t", name, "Enter"]);
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(1000);
    if (await isWorkerIdle(name)) return true;
  }
  return await sessionExists(name);
}

// ============================================================
// 输出轮询 — 等待 worker 完成并收集输出
// ============================================================

async function waitForResponseAndCapture(
  name: string
): Promise<string> {
  const startTime = Date.now();

  // 阶段 1：等待 ❯ 消失（Claude Code 开始处理）
  let startedProcessing = false;
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1000);
    if (!(await isWorkerIdle(name))) {
      startedProcessing = true;
      break;
    }
  }

  if (!startedProcessing) {
    const output = await captureLast(name, 100);
    return cleanTerminalOutput(stripPromptChrome(output));
  }

  // 阶段 2：等待 ❯ 重新出现（Claude Code 处理完毕）
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await Bun.sleep(POLL_INTERVAL_MS);
    if (await isWorkerIdle(name)) {
      const output = await captureLast(name, 100);
      return cleanTerminalOutput(stripPromptChrome(output));
    }
  }

  const finalOutput = await captureLast(name, 100);
  return (
    cleanTerminalOutput(stripPromptChrome(finalOutput)) +
    "\n\n⏱ *（等待超时，worker 可能仍在执行中）*"
  );
}

function stripPromptChrome(raw: string): string {
  const lines = raw.split("\n");
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (
      /❯/.test(line) ||
      /^[─━]+$/.test(line.trim()) ||
      /bypass permissions/.test(line) ||
      /esc to interrupt/.test(line)
    ) {
      end = i;
    } else if (line.trim()) {
      break;
    }
  }
  return lines.slice(0, end).join("\n");
}

function cleanTerminalOutput(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

// ============================================================
// JSONL Session 读取 — 从 Claude Code session 文件获取结构化输出
// ============================================================

/** cwd → Claude Code 项目目录名（路径分隔符替换为 -） */
function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/^\//, "").replace(/\//g, "-");
}

function getSessionJsonlPath(cwd: string, sessionId: string): string {
  const projectDir = cwdToProjectDir(cwd);
  return join(
    process.env.HOME || "~",
    ".claude",
    "projects",
    `-${projectDir}`,
    `${sessionId}.jsonl`
  );
}

const TOOL_EMOJI: Record<string, string> = {
  Read: "📖",
  Edit: "✏️",
  Write: "📝",
  Bash: "💻",
  Glob: "🔍",
  Grep: "🔎",
  Agent: "🤖",
  WebSearch: "🌐",
  WebFetch: "🌐",
};

async function readLastAssistantResponse(
  jsonlPath: string
): Promise<string | null> {
  if (!existsSync(jsonlPath)) return null;

  try {
    const file = Bun.file(jsonlPath);
    const size = file.size;
    // 只读最后 200KB，足够覆盖一轮对话
    const start = Math.max(0, size - 200_000);
    const chunk = await file.slice(start, size).text();
    const lines = chunk.split("\n").filter((l) => l.trim());

    // 从末尾往前找，收集最后一轮 assistant 的内容
    const parts: string[] = [];
    const toolSummaries: string[] = [];

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        // 遇到 user 消息说明这轮结束了
        if (entry.type === "user") break;

        // 跳过非 assistant 类型（tool_result, system 等）
        if (entry.type !== "assistant") continue;

        const content = entry.message?.content;
        if (!content) continue;

        if (typeof content === "string") {
          parts.unshift(content);
        } else if (Array.isArray(content)) {
          const textBuf: string[] = [];
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              textBuf.push(block.text);
            } else if (block.type === "tool_use") {
              const emoji = TOOL_EMOJI[block.name] || "🔧";
              const summary = formatToolUseSummary(
                block.name,
                block.input
              );
              toolSummaries.unshift(`${emoji} ${summary}`);
            }
          }
          if (textBuf.length) parts.unshift(textBuf.join("\n"));
        }
      } catch {}
    }

    if (parts.length === 0 && toolSummaries.length === 0) return null;

    let result = "";
    if (toolSummaries.length > 0) {
      result += toolSummaries.join("\n") + "\n\n";
    }
    result += parts.join("\n\n");
    return result.trim() || null;
  } catch {
    return null;
  }
}

function formatToolUseSummary(name: string, input: any): string {
  switch (name) {
    case "Read":
      return `Read \`${input?.file_path?.split("/").pop() || input?.file_path || ""}\``;
    case "Edit":
      return `Edit \`${input?.file_path?.split("/").pop() || input?.file_path || ""}\``;
    case "Write":
      return `Write \`${input?.file_path?.split("/").pop() || input?.file_path || ""}\``;
    case "Bash": {
      const cmd = input?.command || "";
      return `\`${cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd}\``;
    }
    case "Glob":
      return `Glob \`${input?.pattern || ""}\``;
    case "Grep":
      return `Grep \`${input?.pattern || ""}\``;
    case "Agent":
      return `Agent: ${input?.description || input?.prompt?.slice(0, 40) || ""}`;
    default:
      return name;
  }
}

/** 发送格式化的 Discord 消息（markdown 而非 code block） */
async function sendFormattedResponse(
  channel: TextChannel,
  content: string,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[]
) {
  if (!content) {
    await channel.send({ content: "*(无输出)*", components });
    return;
  }

  // Discord 单条消息限制 2000 字符
  if (content.length <= DISCORD_MAX_LEN) {
    await channel.send({ content, components });
    return;
  }

  // 分块：按段落分割
  const chunks: string[] = [];
  const paragraphs = content.split("\n\n");
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > DISCORD_MAX_LEN) {
      if (current) chunks.push(current.trim());
      // 如果单段超长，硬切
      if (para.length > DISCORD_MAX_LEN) {
        for (let i = 0; i < para.length; i += DISCORD_MAX_LEN) {
          chunks.push(para.slice(i, i + DISCORD_MAX_LEN));
        }
        current = "";
      } else {
        current = para;
      }
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await channel.send({
      content: chunks[i],
      components: isLast ? components : undefined,
    });
    await Bun.sleep(500);
  }
}

function formatAge(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}个月前`;
}

// ============================================================
// Discord 消息分块发送
// ============================================================

async function sendLongMessage(
  channel: TextChannel,
  content: string,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[]
) {
  if (!content) {
    await channel.send({ content: "*(worker 无输出)*", components });
    return;
  }

  const wrapped = "```\n" + content + "\n```";

  if (wrapped.length <= DISCORD_MAX_LEN) {
    await channel.send({ content: wrapped, components });
    return;
  }

  const chunks: string[] = [];
  const lines = content.split("\n");
  let current = "";

  for (const line of lines) {
    if (("```\n" + current + line + "\n```").length > DISCORD_MAX_LEN) {
      if (current) chunks.push("```\n" + current + "```");
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) chunks.push("```\n" + current + "```");

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await channel.send({
      content: chunks[i],
      components: isLast ? components : undefined,
    });
    await Bun.sleep(500);
  }
}

// ============================================================
// Discord UI Components
// ============================================================

function buildControlPanel() {
  const row =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("ctrl_status")
        .setLabel("Worker 状态")
        .setEmoji("📊")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("ctrl_sessions")
        .setLabel("恢复会话")
        .setEmoji("📋")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("ctrl_create")
        .setLabel("新建 Worker")
        .setEmoji("➕")
        .setStyle(ButtonStyle.Success)
    );
  return {
    content: "**🎛 Claude Orchestrator 控制台**",
    components: [row],
  };
}

function buildWorkerActions(workerName: string) {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wk_status:${workerName}`)
      .setLabel("状态")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`wk_peek:${workerName}`)
      .setLabel("查看输出")
      .setEmoji("👁")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`wk_interrupt:${workerName}`)
      .setLabel("中断")
      .setEmoji("⚡")
      .setStyle(ButtonStyle.Danger)
  );
}

// ============================================================
// 创建 Worker 的 Discord 频道
// ============================================================

/** tmux session 名 → Discord 频道名（去掉 worker- 前缀） */
function workerChannelName(tmuxName: string): string {
  return tmuxName.replace(WORKER_PREFIX, "");
}

/** Discord 频道名 → tmux session 名（加上 worker- 前缀） */
function workerTmuxName(channelName: string): string {
  return `${WORKER_PREFIX}${channelName}`;
}

async function ensureWorkerChannel(
  tmuxName: string,
  topic: string
): Promise<void> {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  const chName = workerChannelName(tmuxName);
  const existing = guild.channels.cache.find(
    (c) => c.name === chName && c.isTextBased()
  );
  if (existing) return;
  const category = guild.channels.cache.find(
    (c) => c.name === "workers" && c.type === 4
  );
  await guild.channels.create({
    name: chName,
    parent: category?.id,
    topic,
  });
}

// ============================================================
// Interaction Handlers
// ============================================================

async function handleInteraction(interaction: Interaction) {
  try {
    // ── Buttons ──
    if (interaction.isButton()) {
      const id = interaction.customId;

      // Control panel: Worker 状态
      if (id === "ctrl_status") {
        await interaction.deferReply();
        const workers = await listSessions();
        const reg = await loadRegistry();

        if (workers.length === 0) {
          await interaction.editReply("📭 当前没有活跃的 worker。");
          return;
        }

        const lines: string[] = [];
        for (const name of workers) {
          const idle = await isWorkerIdle(name);
          const info = reg.workers[name];
          const status = idle ? "🟢 空闲" : "🔵 执行中";
          const project = info?.project || "未知";
          const purpose = info?.purpose || "";
          lines.push(
            `**${name}** — ${status}\n📁 \`${project}\` ${purpose}`
          );
        }

        const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] =
          [];

        // Peek 下拉菜单
        const peekMenu =
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("peek_select")
              .setPlaceholder("👁 查看 Worker 输出")
              .addOptions(
                workers.map((w) => ({ label: w, value: w }))
              )
          );
        components.push(peekMenu);

        // Kill 下拉菜单
        const killMenu =
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("kill_select")
              .setPlaceholder("🗑 销毁 Worker")
              .addOptions(
                workers.map((w) => ({ label: w, value: w }))
              )
          );
        components.push(killMenu);

        await interaction.editReply({
          content: "**📊 Worker 状态**\n\n" + lines.join("\n\n"),
          components,
        });
        return;
      }

      // Control panel: 恢复会话
      if (id === "ctrl_sessions") {
        await interaction.deferReply();
        const claudeSessions = await scanClaudeSessions();
        lastSessionsList = claudeSessions;

        if (claudeSessions.length === 0) {
          await interaction.editReply("📭 未找到任何历史会话。");
          return;
        }

        const display = claudeSessions.slice(0, 25);
        const lines: string[] = [];
        for (let i = 0; i < Math.min(display.length, 10); i++) {
          const s = display[i];
          const dir = s.cwd.replace(process.env.HOME || "", "~");
          const age = formatAge(s.modifiedAt);
          const name = s.slug || s.sessionId.slice(0, 8);
          lines.push(`\`${i + 1}\` **${name}** — ${age}\n　　📁 \`${dir}\``);
        }

        const selectMenu =
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("adopt_select")
              .setPlaceholder("📋 选择要恢复的会话")
              .addOptions(
                display.map((s, i) => {
                  const dir = s.cwd.replace(process.env.HOME || "", "~");
                  const label = (s.slug || s.sessionId.slice(0, 8)).slice(
                    0,
                    100
                  );
                  const desc =
                    `${dir} · ${formatAge(s.modifiedAt)}`.slice(0, 100);
                  return {
                    label,
                    value: String(i),
                    description: desc,
                  };
                })
              )
          );

        let content = "**📋 Claude Code 历史会话**\n\n" + lines.join("\n");
        if (claudeSessions.length > 10) {
          content += `\n\n*下拉菜单显示最近 ${display.length} 个会话*`;
        }

        await interaction.editReply({
          content,
          components: [selectMenu],
        });
        return;
      }

      // Control panel: 新建 Worker
      if (id === "ctrl_create") {
        const modal = new ModalBuilder()
          .setCustomId("create_modal")
          .setTitle("新建 Worker");

        const nameInput = new TextInputBuilder()
          .setCustomId("worker_name")
          .setLabel("Worker 名称")
          .setPlaceholder("例：alpha")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50);

        const dirInput = new TextInputBuilder()
          .setCustomId("worker_dir")
          .setLabel("工作目录")
          .setPlaceholder("~/repos/my-project")
          .setValue("~")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const purposeInput = new TextInputBuilder()
          .setCustomId("worker_purpose")
          .setLabel("用途描述（可选）")
          .setPlaceholder("主力开发")
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(dirInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(purposeInput)
        );

        await interaction.showModal(modal);
        return;
      }

      // Worker channel: 状态
      if (id.startsWith("wk_status:")) {
        const workerName = id.slice("wk_status:".length);
        await interaction.deferReply();
        if (!(await sessionExists(workerName))) {
          await interaction.editReply(`⚠️ \`${workerName}\` 不存在。`);
          return;
        }
        const idle = await isWorkerIdle(workerName);
        const output = await captureLast(workerName, 20);
        const status = idle ? "🟢 空闲，等待指令。" : "🔵 正在执行中...";
        const cleaned = cleanTerminalOutput(output);
        const text =
          status +
          "\n```\n" +
          cleaned.slice(0, DISCORD_MAX_LEN - 200) +
          "\n```";
        await interaction.editReply(text);
        return;
      }

      // Worker channel: 查看输出
      if (id.startsWith("wk_peek:")) {
        const workerName = id.slice("wk_peek:".length);
        await interaction.deferReply();
        if (!(await sessionExists(workerName))) {
          await interaction.editReply(`⚠️ \`${workerName}\` 不存在。`);
          return;
        }
        const output = await captureLast(workerName, 40);
        const cleaned = cleanTerminalOutput(output);
        await interaction.editReply(
          "```\n" + cleaned.slice(0, DISCORD_MAX_LEN - 50) + "\n```"
        );
        return;
      }

      // Worker channel: 中断
      if (id.startsWith("wk_interrupt:")) {
        const workerName = id.slice("wk_interrupt:".length);
        if (!(await sessionExists(workerName))) {
          await interaction.reply({
            content: `⚠️ \`${workerName}\` 不存在。`,
            ephemeral: true,
          });
          return;
        }
        await tmuxRaw(["send-keys", "-t", workerName, "C-c"]);
        await interaction.reply("⚡ 已发送 Ctrl-C 中断。");
        return;
      }
    }

    // ── Select Menus ──
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;

      // Peek worker
      if (id === "peek_select") {
        const workerName = interaction.values[0];
        await interaction.deferReply();
        if (!(await sessionExists(workerName))) {
          await interaction.editReply(`⚠️ \`${workerName}\` 不存在。`);
          return;
        }
        const output = await captureLast(workerName, 40);
        const cleaned = cleanTerminalOutput(output);
        await interaction.editReply(
          `**👁 ${workerName} 最近输出**\n\`\`\`\n${cleaned.slice(0, DISCORD_MAX_LEN - 100)}\n\`\`\``
        );
        return;
      }

      // Kill worker
      if (id === "kill_select") {
        const workerName = interaction.values[0];
        if (!(await sessionExists(workerName))) {
          await interaction.reply({
            content: `⚠️ \`${workerName}\` 不存在。`,
            ephemeral: true,
          });
          return;
        }
        await killWorkerSession(workerName);
        const reg = await loadRegistry();
        if (reg.workers[workerName]) {
          reg.workers[workerName].status = "stopped";
          await saveRegistry(reg);
        }
        await interaction.reply(
          `🗑️ \`${workerName}\` 已销毁。Discord 频道保留供查看历史。`
        );
        return;
      }

      // Adopt session → 弹出命名 modal
      if (id === "adopt_select") {
        const idx = parseInt(interaction.values[0]);
        if (isNaN(idx) || idx < 0 || idx >= lastSessionsList.length) {
          await interaction.reply({
            content: "⚠️ 会话选择无效，请重新点击「恢复会话」。",
            ephemeral: true,
          });
          return;
        }

        const session = lastSessionsList[idx];
        const dir = session.cwd.replace(process.env.HOME || "", "~");

        const modal = new ModalBuilder()
          .setCustomId(`adopt_modal:${idx}`)
          .setTitle("恢复会话");

        const defaultName = session.slug || session.sessionId.slice(0, 8);
        const nameInput = new TextInputBuilder()
          .setCustomId("worker_name")
          .setLabel("Worker 名称")
          .setValue(defaultName)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50);

        const dirDisplay = new TextInputBuilder()
          .setCustomId("worker_dir")
          .setLabel("工作目录（可修改）")
          .setValue(dir)
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(dirDisplay)
        );

        await interaction.showModal(modal);
        return;
      }
    }

    // ── Modal Submit ──
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "create_modal") {
        const rawName = interaction.fields.getTextInputValue("worker_name");
        const dir = interaction.fields.getTextInputValue("worker_dir");
        const purpose =
          interaction.fields.getTextInputValue("worker_purpose") || "";

        const name = `${WORKER_PREFIX}${rawName.replace(WORKER_PREFIX, "")}`.toLowerCase();

        if (await sessionExists(name)) {
          await interaction.reply({
            content: `⚠️ \`${name}\` 已存在。`,
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply();
        await interaction.editReply(
          `⏳ 正在创建 \`${name}\`，启动 Claude Code...`
        );

        const expandedDir = dir.replace("~", process.env.HOME || "~");
        const newSessionId = crypto.randomUUID();
        const ok = await createWorkerSession(name, expandedDir, newSessionId);

        if (ok) {
          const reg = await loadRegistry();
          reg.workers[name] = {
            project: dir,
            purpose,
            created: new Date().toISOString(),
            status: "active",
            notes: "",
            sessionId: newSessionId,
            cwd: expandedDir,
          };
          await saveRegistry(reg);
          await ensureWorkerChannel(name, `${purpose} | ${dir}`);
          await interaction.editReply(
            `✅ \`${name}\` 已创建并就绪。去 #${workerChannelName(name)} 频道开始对话。`
          );
        } else {
          await interaction.editReply(
            `❌ 创建 \`${name}\` 失败，请检查目录是否存在。`
          );
        }
        return;
      }

      // Adopt modal: 恢复历史会话
      if (interaction.customId.startsWith("adopt_modal:")) {
        const idx = parseInt(interaction.customId.split(":")[1]);
        if (isNaN(idx) || idx < 0 || idx >= lastSessionsList.length) {
          await interaction.reply({
            content: "⚠️ 会话已过期，请重新点击「恢复会话」。",
            ephemeral: true,
          });
          return;
        }

        const session = lastSessionsList[idx];
        const rawName = interaction.fields.getTextInputValue("worker_name");
        const dir = interaction.fields.getTextInputValue("worker_dir");
        const name = `${WORKER_PREFIX}${rawName.replace(WORKER_PREFIX, "")}`.toLowerCase();

        if (await sessionExists(name)) {
          await interaction.reply({
            content: `⚠️ \`${name}\` 已存在。换个名字试试。`,
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply();
        await interaction.editReply(
          `⏳ 正在恢复会话为 \`${name}\`...\n📁 \`${dir}\``
        );

        const expandedDir = dir.replace("~", process.env.HOME || "~");
        const displayName = workerChannelName(name);
        const ok = await resumeWorkerSession(
          name,
          expandedDir,
          session.sessionId,
          displayName
        );

        if (ok) {
          const reg = await loadRegistry();
          reg.workers[name] = {
            project: dir,
            purpose: `resumed: ${session.slug || session.sessionId.slice(0, 8)}`,
            created: new Date().toISOString(),
            status: "active",
            channelId: undefined,
            notes: `claude session: ${session.sessionId}`,
            sessionId: session.sessionId,
            cwd: expandedDir,
          };
          await saveRegistry(reg);
          await ensureWorkerChannel(
            name,
            `${session.slug} | ${dir} | resumed session`
          );
          await interaction.editReply(
            `✅ \`${name}\` 已就绪。去 #${workerChannelName(name)} 频道继续对话。`
          );
        } else {
          await interaction.editReply(
            `❌ 恢复失败，请检查 session 是否有效。`
          );
        }
        return;
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
    const msg = `❌ 操作出错：${(err as Error).message}`;
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(msg);
        } else {
          await interaction.reply({ content: msg, ephemeral: true });
        }
      }
    } catch {}
  }
}

// ============================================================
// Worker Channel 消息处理
// ============================================================

async function handleWorkerMessage(
  workerName: string,
  message: string,
  channel: TextChannel
) {
  if (!(await sessionExists(workerName))) {
    await channel.send(
      `⚠️ \`${workerName}\` 的 tmux session 不存在。去 #${CONTROL_CHANNEL} 创建。`
    );
    return;
  }

  const actionRow = buildWorkerActions(workerName);

  // 快捷命令（保留文字版作为备用）
  if (message.trim() === "/status") {
    const idle = await isWorkerIdle(workerName);
    const output = await captureLast(workerName, 20);
    await channel.send(idle ? "🟢 空闲，等待指令。" : "🔵 正在执行中...");
    await sendLongMessage(channel, cleanTerminalOutput(output), [actionRow]);
    return;
  }

  if (message.trim() === "/peek") {
    const output = await captureLast(workerName, 40);
    await sendLongMessage(channel, cleanTerminalOutput(output), [actionRow]);
    return;
  }

  if (message.trim() === "/interrupt") {
    await tmuxRaw(["send-keys", "-t", workerName, "C-c"]);
    await channel.send({ content: "⚡ 已发送 Ctrl-C 中断。", components: [actionRow] });
    return;
  }

  // 检查 worker 是否空闲
  const idle = await isWorkerIdle(workerName);
  if (!idle) {
    await channel.send({
      content:
        "⏳ worker 正在执行中，排队等待...",
      components: [actionRow],
    });
    const waitStart = Date.now();
    while (Date.now() - waitStart < 60_000) {
      await Bun.sleep(2000);
      if (await isWorkerIdle(workerName)) break;
    }
    if (!(await isWorkerIdle(workerName))) {
      await channel.send({
        content: "⚠️ 等了 1 分钟 worker 仍在忙，消息未发送。",
        components: [actionRow],
      });
      return;
    }
  }

  // 发送到 worker
  await sendToWorker(workerName, message);
  await channel.send("📨 已发送，等待响应...");

  // 等待 worker 完成
  await waitForResponseAndCapture(workerName);

  // 优先从 JSONL 读取结构化输出
  const reg = await loadRegistry();
  const info = reg.workers[workerName];
  let response: string | null = null;

  if (info?.sessionId && info?.cwd) {
    const jsonlPath = getSessionJsonlPath(info.cwd, info.sessionId);
    response = await readLastAssistantResponse(jsonlPath);
  }

  if (response) {
    await sendFormattedResponse(channel, response, [actionRow]);
  } else {
    // 回退：从终端截取
    const output = await captureLast(workerName, 100);
    await sendLongMessage(
      channel,
      cleanTerminalOutput(stripPromptChrome(output)),
      [actionRow]
    );
  }
}

// ============================================================
// Discord Client
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`✅ Bot 上线: ${client.user?.tag}`);
  console.log(`📡 tmux socket: ${SOCK}`);

  await ensureSocket();

  const sessions = await listSessions();
  console.log(
    `🔍 发现 ${sessions.length} 个活跃 worker: ${sessions.join(", ") || "(无)"}`
  );

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    // 确保 workers category 存在
    const hasCategory = guild.channels.cache.find(
      (c) => c.name === "workers" && c.type === 4
    );
    if (!hasCategory) {
      console.log("📁 创建 workers category...");
      await guild.channels.create({ name: "workers", type: 4 });
    }

    // 确保 #control 频道存在
    let controlChannel = guild.channels.cache.find(
      (c) => c.name === CONTROL_CHANNEL && c.isTextBased()
    ) as TextChannel | undefined;

    if (!controlChannel) {
      console.log("📁 创建 #control 频道...");
      controlChannel = (await guild.channels.create({
        name: CONTROL_CHANNEL,
        topic: "Worker 管理控制台",
      })) as TextChannel;
    }

    // 在 #control 发送控制面板
    await controlChannel.send(buildControlPanel());
  }
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (msg.guildId !== GUILD_ID) return;

  const channel = msg.channel as TextChannel;
  const channelName = channel.name;
  const content = msg.content.trim();

  if (!content) return;

  try {
    if (channelName === CONTROL_CHANNEL) {
      // #control 里发任何文字都回复控制面板
      await channel.send(buildControlPanel());
    } else if (channel.parent?.name === "workers") {
      // workers 分组下的频道 → 映射到 worker-{channelName} tmux session
      const tmuxName = workerTmuxName(channelName);
      await handleWorkerMessage(tmuxName, content, channel);
    }
  } catch (err) {
    console.error(`Error handling message in #${channelName}:`, err);
    await channel.send(`❌ 处理出错：${(err as Error).message}`);
  }
});

client.on("interactionCreate", handleInteraction);

// ============================================================
// 启动
// ============================================================

if (!DISCORD_TOKEN) {
  console.error("❌ 请设置 DISCORD_BOT_TOKEN 环境变量");
  process.exit(1);
}
if (!GUILD_ID) {
  console.error("❌ 请设置 DISCORD_GUILD_ID 环境变量");
  process.exit(1);
}

client.login(DISCORD_TOKEN);
