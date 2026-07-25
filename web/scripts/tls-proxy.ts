/**
 * TLS 终结代理：https://mac-mini-jp.<tailnet>.ts.net → http://127.0.0.1:33333
 *
 * ⚠ 已退役(2026-07-14):裸 TCP 代理只有 HTTP/1.1——Safari 每域名 6 连接,
 * dev 模式几百个 chunk 串行化,手机端加载卡死(真机:登录按钮永久转圈/卡
 * Splash)。现役方案 = Caddy(brew)做 h2 终结,LaunchAgent
 * com.claudestra.tls-proxy 指 caddy run --config
 * ~/.claude-orchestrator/web/caddy/Caddyfile。本文件保留作无 caddy 环境的备用。
 *
 * 为什么存在（2026-07-14）：getUserMedia 要求安全上下文，经 Tailscale IP 的
 * HTTP 访问被浏览器硬禁麦克风（语音输入）。tailscale serve 本是首选，但 macOS
 * GUI 版 CLI 在本机报「The Tailscale GUI failed to start (CLIError error 3)」
 * 写不进 serve 配置——于是 `tailscale cert` 签发 ts.net 证书 + 本脚本自己做
 * TLS 终结。裸 TCP 双向转发,HTTP/SSE/WebSocket(Next HMR)全部透明。
 *
 * - 监听 0.0.0.0:443——macOS 非 root 只许绑低端口的通配地址(绑具体 IP 报
 *   EACCES)。LAN 暴露面与 dev server(0.0.0.0:33333)一致,应用自带登录;
 *   证书只对 ts.net 域名有效,证书校验型客户端只会经 tailnet 名访问
 * - 证书: ~/.claude-orchestrator/web/tls/mac.{crt,key}（tailscale cert 签发,
 *   90 天有效——过期前重跑 `tailscale cert` 后重启本进程,见 renewIfNeeded）
 * - 运行: LaunchAgent com.claudestra.tls-proxy（bun 直跑本文件）
 */

import { spawnSync } from "child_process";
import { existsSync, statSync } from "fs";

const HOME = process.env.HOME!;
const TLS_DIR = `${HOME}/.claude-orchestrator/web/tls`;
const CERT = `${TLS_DIR}/mac.crt`;
const KEY = `${TLS_DIR}/mac.key`;
// 你自己的 tailnet 主机名与 Tailscale CLI 路径，从环境变量读（此前这两个值写死
// 的是作者本机的，别人跑这个脚本必然签不出证书）。App Store 版 Tailscale 的 CLI
// 在 /Applications/... ，brew 版通常在 /opt/homebrew/bin/tailscale。
const TS_CLI =
  process.env.TLS_PROXY_TS_CLI || "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const TS_HOST = process.env.TLS_PROXY_HOST || "";
if (!TS_HOST) {
  console.error(
    "[tls-proxy] 未设置 TLS_PROXY_HOST —— 需要你的 tailnet 主机名，形如 my-mac.tailXXXX.ts.net\n" +
      "           （`tailscale status` 能看到）。设好再起本进程。"
  );
  process.exit(1);
}
const LISTEN_HOST = process.env.TLS_PROXY_BIND || "0.0.0.0";
const LISTEN_PORT = Number(process.env.TLS_PROXY_PORT || 443);
const BACKEND_PORT = Number(process.env.TLS_PROXY_BACKEND || 33333);

/** 证书 60 天以上旧(90 天有效)→ 启动时尝试续签;失败继续用旧证书。 */
function renewIfNeeded(): void {
  try {
    const ageDays = existsSync(CERT)
      ? (Date.now() - statSync(CERT).mtimeMs) / 86_400_000
      : Infinity;
    if (ageDays < 60) return;
    const r = spawnSync(TS_CLI, ["cert", "--cert-file", CERT, "--key-file", KEY, TS_HOST], {
      timeout: 30_000,
    });
    console.log(`tls-proxy: cert renew ${r.status === 0 ? "ok" : "failed (keep old)"}`);
  } catch (e) {
    console.log("tls-proxy: cert renew error (keep old):", (e as Error).message);
  }
}
renewIfNeeded();

interface Pipe {
  backend: import("bun").Socket | null;
  queue: Uint8Array[];
}

Bun.listen<Pipe>({
  hostname: LISTEN_HOST,
  port: LISTEN_PORT,
  tls: { cert: Bun.file(CERT), key: Bun.file(KEY) },
  socket: {
    open(socket) {
      socket.data = { backend: null, queue: [] };
      Bun.connect<undefined>({
        hostname: "127.0.0.1",
        port: BACKEND_PORT,
        socket: {
          data(_b, chunk) {
            socket.write(chunk);
          },
          close() {
            socket.end();
          },
          error() {
            socket.end();
          },
        },
      })
        .then((backend) => {
          socket.data.backend = backend;
          // 握手期间到达的字节按序补发
          for (const chunk of socket.data.queue) backend.write(chunk);
          socket.data.queue = [];
        })
        .catch(() => socket.end());
    },
    data(socket, chunk) {
      const d = socket.data;
      if (d.backend) d.backend.write(chunk);
      else d.queue.push(new Uint8Array(chunk));
    },
    close(socket) {
      socket.data.backend?.end();
    },
    error(socket) {
      socket.data.backend?.end();
    },
    drain() {
      /* dev 规模不做背压 */
    },
  },
});

console.log(
  `tls-proxy: https://${TS_HOST} (${LISTEN_HOST}:${LISTEN_PORT}) → http://127.0.0.1:${BACKEND_PORT}`
);
