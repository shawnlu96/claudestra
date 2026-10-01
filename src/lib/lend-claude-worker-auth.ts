/** setup-token 经一次性、本用户可连的 Unix socket 交给宿主；不进入启动命令或落盘文件。 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { runtimePath } from "./paths.js";

export function serveClaudeToken(token: string, root = runtimePath("lend-auth"), ttlMs = 120_000) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, "cc-"));
  chmodSync(dir, 0o700);
  const path = join(dir, "auth.sock");
  if (Buffer.byteLength(path) > 100) { rmSync(dir, { recursive: true }); throw new Error("Claude token socket 路径过长，请缩短 CLAUDESTRA_RUNTIME_DIR"); }
  let used = false, closed = false;
  const server = createServer((socket) => {
    if (used) { socket.destroy(); return; }
    used = true;
    socket.on("error", () => close()); // 接收方已退出：丢弃 token，不允许重放
    socket.end(token, () => close());
    token = "";
  });
  const close = () => {
    if (closed) return;
    closed = true;
    token = "";
    clearTimeout(timer);
    server.close();
    rmSync(dir, { recursive: true, force: true });
    process.removeListener("exit", close);
  };
  const timer = setTimeout(close, ttlMs);
  timer.unref();
  server.on("error", () => close()); // 无 token 回退；宿主连接失败会明确拒绝启动
  server.listen(path);
  server.unref();
  process.once("exit", close);
  return { path, close };
}

export function receiveClaudeToken(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let token = "";
    const fail = () => { socket.destroy(); reject(new Error("Claude 出借登录凭据交接失败，请核对调度服务的 CLAUDE_CODE_OAUTH_TOKEN")); };
    socket.setTimeout(10_000, fail);
    socket.on("error", fail);
    socket.on("data", (data) => { token += data.toString(); if (token.length > 16_384) fail(); });
    socket.on("end", () => { socket.destroy(); token.trim() ? resolve(token) : fail(); });
  });
}
