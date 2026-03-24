# 从零搭建 Claude Code 大总管

这份指南覆盖从 tmux 安装到手机操控的完整流程。假设你用的是 Mac + iTerm2。

---

## 第一步：安装依赖

```bash
# tmux
brew install tmux

# Bun（Discord bot 运行时）
curl -fsSL https://bun.sh/install | bash

# Claude Code（如果还没装）
npm install -g @anthropic-ai/claude-code

# 确认版本
tmux -V        # 需要 3.x+
bun --version  # 需要 1.x+
claude --version  # 需要 2.1.80+
```

---

## 第二步：tmux 速成（5 分钟搞定）

### tmux 是什么

一个终端复用器。你可以在一个终端里开多个"虚拟窗口"，关掉终端窗口后进程照跑，随时重新连回去。

### 你唯一需要知道的概念

```
tmux server（后台守护进程）
  └── session（一个工作空间，比如 "worker-alpha"）
        └── window（session 里的 tab）
              └── pane（window 里的分屏）
```

我们的用法很简单：每个 worker = 一个 session，每个 session 只有一个 window 一个 pane。

### 基本命令

```bash
# 创建一个后台 session
tmux new-session -d -s mytest

# 看有哪些 session
tmux list-sessions

# 连上去（你会进入那个虚拟终端）
tmux attach -t mytest

# 在里面操作完了，按 Ctrl+B 然后按 D 离开（session 继续跑）
# 这叫 "detach"，记住这个组合键：Ctrl+B, D

# 彻底杀掉一个 session
tmux kill-session -t mytest
```

### 试一下

```bash
tmux new-session -d -s test-claude
tmux send-keys -t test-claude "echo hello from tmux" Enter
sleep 1
tmux capture-pane -t test-claude -p   # 你会看到 "hello from tmux"
tmux kill-session -t test-claude
```

如果这一步成功了，说明 tmux 已经就绪。

---

## 第三步：iTerm2 + tmux 无缝集成

这是实现"手机 → Mac 无缝切换"的关键。

### 方式 A：直接 attach（推荐先用这个）

最简单的方式，打开 iTerm2，输入：

```bash
tmux -S /tmp/claude-orchestrator/master.sock attach
```

你就能看到所有 worker session。用 `Ctrl+B` 然后 `S` 可以在不同 session 之间切换。

快捷键速查：
- `Ctrl+B, D` — detach（离开，session 继续跑）
- `Ctrl+B, S` — 列出所有 session 并切换
- `Ctrl+B, W` — 列出所有 window 并切换
- `Ctrl+B, [` — 进入滚动模式（用方向键/PgUp 翻看历史，按 Q 退出）

### 方式 B：iTerm2 tmux Integration（-CC 模式）

这个更高级：tmux 的每个 window 变成 iTerm2 的原生 tab，体验和普通终端一样，但底层是 tmux。

```bash
# 用 -CC 模式 attach
tmux -S /tmp/claude-orchestrator/master.sock -CC attach
```

iTerm2 会弹出提示问你要怎么处理，选 "Open tmux windows as tabs in the current window"。

之后每个 tmux session/window 就是一个 iTerm2 tab。你直接用 Cmd+数字键切换。

**注意**：-CC 模式下你不需要记任何 tmux 快捷键，iTerm2 完全接管了 UI。

### 方式 C：给 iTerm2 加个快捷启动 Profile

1. iTerm2 → Settings → Profiles → 点 "+"
2. Name: `Orchestrator`
3. Command: 选 "Command"，填入：
   ```
   /opt/homebrew/bin/tmux -S /tmp/claude-orchestrator/master.sock -CC attach
   ```
4. 保存

以后打开 iTerm2，新建一个 "Orchestrator" profile 的 tab，直接进入所有 worker 管理界面。

---

## 第四步：创建 Discord Bot

### 4.1 在 Discord Developer Portal 创建 Bot

1. 打开 https://discord.com/developers/applications
2. 点 **New Application**，起名（如 "Claude Orchestrator"）
3. 左侧 **Bot** → **Reset Token** → 复制 token（只显示一次！）
4. 往下翻到 **Privileged Gateway Intents**，打开：
   - ✅ Message Content Intent
5. 左侧 **OAuth2 → URL Generator**：
   - Scopes: 勾 `bot`
   - Bot Permissions: 勾 `Send Messages`, `Manage Channels`, `Read Message History`
6. 复制生成的 URL，在浏览器打开，把 bot 邀请到你的 Discord server

### 4.2 获取 Server ID

1. Discord 设置 → 高级 → 打开 **开发者模式**
2. 右键你的 server 名 → **Copy Server ID**

### 4.3 配置环境变量

```bash
# 在 orchestrator 目录下创建 .env
cat > ~/orchestrator/.env << 'EOF'
DISCORD_BOT_TOKEN=你的bot-token
DISCORD_GUILD_ID=你的server-id
EOF
```

### 4.4 安装依赖并启动

```bash
cd ~/orchestrator
bun install
bun run bot.ts
```

如果看到 `✅ Bot 上线` 就成功了。Bot 会自动在你的 Discord server 里创建 `#control` 频道和 `workers` 分组。

### 4.5 让 Bot 持久运行

```bash
# 方式 A：用 tmux 跑（推荐）
tmux new-session -d -s orchestrator-bot -c ~/orchestrator
tmux send-keys -t orchestrator-bot "bun run bot.ts" Enter

# 方式 B：用 launchd（Mac 开机自启）
# 创建 plist 文件
cat > ~/Library/LaunchAgents/com.claude.orchestrator.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude.orchestrator</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.bun/bin/bun</string>
    <string>run</string>
    <string>$HOME/orchestrator/bot.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$HOME/orchestrator</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DISCORD_BOT_TOKEN</key>
    <string>你的token</string>
    <key>DISCORD_GUILD_ID</key>
    <string>你的server-id</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/claude-orchestrator/bot.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claude-orchestrator/bot.err</string>
</dict>
</plist>
EOF

# 加载
launchctl load ~/Library/LaunchAgents/com.claude.orchestrator.plist
```

---

## 第五步：日常使用流程

### 在手机上（通过 Discord）

```
#control 频道：
  create alpha ~/projects/my-app 主力开发
  list
  kill alpha

#worker-alpha 频道：
  帮我检查 src/auth.ts 的错误处理逻辑
  /status
  /peek
  /interrupt
```

### 回到 Mac 上

打开 iTerm2，选 Orchestrator profile（或手动 attach）：

```bash
tmux -S /tmp/claude-orchestrator/master.sock -CC attach
```

你立刻看到所有 worker 的完整终端，包括手机上触发的所有操作历史。直接在终端里跟 Claude Code 对话，就像一直在 Mac 前一样。

### 工作流示意

```
 上午 10:00  手机 Discord #control → create alpha ~/projects/app
 上午 10:01  手机 Discord #worker-alpha → 帮我修复登录 bug
 上午 10:15  手机 Discord #worker-alpha → /status  (看看进度)
       ...    (通勤中，alpha 在后台干活)
 上午 11:00  到公司，打开 Mac iTerm2 → attach
             看到 alpha 的完整终端输出，直接继续对话
 下午  2:00  Mac 上直接在 tmux 里操作 worker-bravo
 下午  5:00  离开公司，手机 Discord 继续
```

---

## 故障排除

### Bot 连不上 / 消息没反应

```bash
# 检查 bot 是否在跑
tmux list-sessions | grep orchestrator-bot

# 看 bot 日志
tmux capture-pane -t orchestrator-bot -p | tail -20

# 检查 token
echo $DISCORD_BOT_TOKEN  # 不应该为空
```

### tmux socket 丢失（Mac 重启后）

```bash
# socket 在 /tmp 下，重启会清空
# 需要重新启动 bot（它会自动创建 socket 目录）
cd ~/orchestrator && bun run bot.ts

# 然后重新创建 worker
# 在 Discord #control：create alpha ~/projects/my-app
```

### Worker 卡住不响应

```
在 Discord #worker-alpha 频道发:
/interrupt

如果还是不行，去 #control:
kill alpha
create alpha ~/projects/my-app 重建
```

### iTerm2 -CC 模式出问题

```bash
# 回退到普通 attach
tmux -S /tmp/claude-orchestrator/master.sock attach

# 或者用 iTerm2 的 Shell → tmux → Dashboard 管理
```
