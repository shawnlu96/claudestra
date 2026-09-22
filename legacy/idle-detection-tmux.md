# 旧版空闲检测：tmux 屏幕比较法

已被 Claude Code hooks (Stop/Notification) 替代。备份代码如下。

## jsonl-watcher.ts 中的 tmux 检测

```typescript
// tmux 屏幕比较法：连续 3 次截取相同 = 空闲
let lastCapture = "";
let sameCount = 0;
state.tmuxChecker = setInterval(async () => {
  if (!state.onIdle) return;
  try {
    const target = `master:${state.workerName}`;
    const proc = Bun.spawn(["tmux", "-S", TMUX_SOCK, "capture-pane", "-t", target, "-p"], {
      stdout: "pipe", stderr: "pipe",
    });
    const capture = await new Response(proc.stdout).text();
    await proc.exited;
    if (capture === lastCapture) {
      sameCount++;
      if (sameCount >= 3) {
        state.onIdle();
        sameCount = 0;
        lastCapture = "";
      }
    } else {
      sameCount = 0;
      lastCapture = capture;
    }
  } catch { /* non-critical */ }
}, 1000);
```

## bridge.ts 中的大总管 fallback

```typescript
// 大总管等不在 registry 的频道：只用 tmux 屏幕比较检测
const tmuxTarget = "master:0";
let lastCap = "";
let sameN = 0;
const checker = setInterval(async () => {
  try {
    const proc = Bun.spawn(["tmux", "-S", TMUX_SOCK, "capture-pane", "-t", tmuxTarget, "-p"], {
      stdout: "pipe", stderr: "pipe",
    });
    const cap = await new Response(proc.stdout).text();
    await proc.exited;
    if (cap === lastCap) {
      sameN++;
      if (sameN >= 3) { onIdleCb(); sameN = 0; lastCap = ""; }
    } else { sameN = 0; lastCap = cap; }
  } catch { /* non-critical */ }
}, 1000);
// 存到 clients 里方便清理
(clients.get(chId) as any)._masterChecker = checker;
```
