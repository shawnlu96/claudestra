/**
 * 中继入口：`bun run src/relay.ts`（systemd 单元见 deploy/relay/）。配置全部来自环境变量（src/relay/env.ts）。
 * 中心改名档位（rename.centerReceive / centerSend）由改名环境变量（后缀 RENAME_CENTER_RECEIVE / RENAME_CENTER_SEND，floka-env 双认）给，缺省 off。
 * SIGTERM / SIGINT → 给所有连接发 1012 再退出，实例收到就立刻重连：滚动升级不需要等心跳判死。
 */
import { parseCenterRename, type CenterRenameConfig } from "./lib/floka-center/gear.js";
import { readRenamedEnv } from "./lib/floka-env/read.js";
import { loadOrCreateVapidKeys } from "./lib/web-push.js";
import { relayEnv } from "./relay/env.js";
import { createRelay } from "./relay/server.js";
import pkg from "../package.json";

/** rename 一节的两项各对应一个改名环境变量（旧名 / 新名由 floka-env 的双认 helper 取，不在这里手写） */
const RENAME_ENV_SUFFIXES = { centerReceive: "RENAME_CENTER_RECEIVE", centerSend: "RENAME_CENTER_SEND" } as const;

/**
 * 中心的 rename 档位：从环境读、parseCenterRename 解析。读不到、读不懂一律 off，problems 原样返回给启动日志。
 * 交给 createRelay 的是解析后的档位，中心那边不会再报一遍同样的问题。
 */
function relayCenterRename(env: Record<string, string | undefined> = process.env): { rename: CenterRenameConfig; problems: string[] } {
  const raw: Record<string, string> = {};
  for (const [k, suffix] of Object.entries(RENAME_ENV_SUFFIXES)) {
    const v = readRenamedEnv(suffix, env)?.trim();
    if (v) raw[k] = v;
  }
  const { rename, problems } = parseCenterRename(raw);
  return { rename: { centerReceive: rename.receive, centerSend: rename.send }, problems };
}

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

const center = relayCenterRename();
for (const p of center.problems) console.error(`[relay] ${p}`);
console.log(`[relay] 中心改名档位：接收 ${center.rename.centerReceive}，发送 ${center.rename.centerSend}`);

const relay = createRelay({
  base: env.base, port: env.port, hostname: env.hostname, db: env.db, trustProxy: env.trustProxy,
  limits: { maxFrameBytes: env.maxFrameBytes }, version: pkg.version, commit: env.commit, staticDir: env.staticDir,
  push: { vapid, apns: env.apns }, rename: center.rename,
});

const shutdown = (sig: string) => {
  console.log(`[relay] ${sig}：关闭全部连接（1012）并退出`);
  relay.stop();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
