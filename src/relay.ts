/**
 * 中继入口：`bun run src/relay.ts`（systemd 单元见 deploy/relay/）。配置全部来自环境变量（src/relay/env.ts）。
 * SIGTERM / SIGINT → 给所有连接发 1012 再退出，实例收到就立刻重连：滚动升级不需要等心跳判死。
 */
import { loadOrCreateVapidKeys } from "./lib/web-push.js";
import { relayEnv } from "./relay/env.js";
import { createRelay } from "./relay/server.js";
import pkg from "../package.json";

let env;
let vapid;
try {
  env = relayEnv();
  // 推送网关的 VAPID 身份：文件不在就生成（0600）；文件坏了直接退出——静默换钥匙会让所有浏览器的订阅失效
  vapid = { ...loadOrCreateVapidKeys(env.vapidKeysPath), subject: env.vapidSubject };
} catch (e) {
  console.error(`[relay] ${(e as Error).message}`);
  process.exit(2);
}
console.log(`[relay] 推送网关：VAPID 公钥 ${vapid.publicKey.slice(0, 12)}…（${env.vapidKeysPath}）；APNs ${env.apns ? `已配置（${env.apns.env}，topic ${env.apns.topic}）` : `未开：${env.apnsWhy}`}`);

const relay = createRelay({
  base: env.base, port: env.port, hostname: env.hostname, db: env.db, trustProxy: env.trustProxy,
  limits: { maxFrameBytes: env.maxFrameBytes }, version: pkg.version, commit: env.commit, staticDir: env.staticDir,
  push: { vapid, apns: env.apns },
});

const shutdown = (sig: string) => {
  console.log(`[relay] ${sig}：关闭全部连接（1012）并退出`);
  relay.stop();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
