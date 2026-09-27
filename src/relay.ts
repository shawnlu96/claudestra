/**
 * 中继入口：`bun run src/relay.ts`（systemd 单元见 deploy/relay/）。配置全部来自环境变量（src/relay/env.ts）。
 * SIGTERM / SIGINT → 给所有连接发 1012 再退出，实例收到就立刻重连：滚动升级不需要等心跳判死。
 */
import { relayEnv } from "./relay/env.js";
import { createRelay } from "./relay/server.js";
import pkg from "../package.json";

let env;
try {
  env = relayEnv();
} catch (e) {
  console.error(`[relay] ${(e as Error).message}`);
  process.exit(2);
}

const relay = createRelay({
  base: env.base, port: env.port, hostname: env.hostname, db: env.db, trustProxy: env.trustProxy,
  limits: { maxFrameBytes: env.maxFrameBytes }, version: pkg.version, commit: env.commit,
});

const shutdown = (sig: string) => {
  console.log(`[relay] ${sig}：关闭全部连接（1012）并退出`);
  relay.stop();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
