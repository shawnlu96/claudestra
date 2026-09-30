/**
 * 沙箱 lab 的中继 + 假推送端点（一个进程，scripts/sandbox.ts `__lab-relay` 拉起，docs/architecture/sandbox.md「Lab mode」）。
 *
 * - 中继：src/relay/server.ts 原样，只听 127.0.0.1:<lab 中继端口>，库 / VAPID 都在 lab 目录里。
 * - 假推送端点，两个自签名 TLS 监听：Web Push 在 127.0.0.1:<假推送端口>（HTTP/1.1，web-push 库只讲它），中继只许投到这个
 *   origin（pinEndpointOrigin）；假 APNs 在 127.0.0.1:<假 APNs 端口>（h2，Bun 的 http2 服务端不回落 HTTP/1.1，所以分开），
 *   APNs 会话由注入的 connect 直接连它（ApnsClient 从不解析 Apple 的主机名），p8 是 lab 自己生成的。
 *   收到的每条推送落盘到 <lab>/push-sink/：APNs 是明文 JSON；Web Push 用 lab 订阅时留下的浏览器私钥解开（像浏览器那样）。
 *
 * 中继的配置全在这里写死，不读 RELAY_* 环境；环境里带着推送凭据（APNS_* / RELAY_APNS_* / RELAY_VAPID_*）就拒绝启动——
 * 那是真推送的配置，出现在 lab 里说明有人绕过脚本手动起。RELAY_URL / RELAY_NAME 是 bridge 侧的键（沙箱环境里本来就有）。
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { join } from "node:path";
import { isLab, LAB_APNS_PORT_ENV, LAB_FLAG, LAB_PUSH_PORT_ENV, LAB_RELAY_PORT_ENV, LAB_ROOT_ENV } from "../src/lib/sandbox-lab.js";
import { loadOrCreateVapidKeys } from "../src/lib/web-push.js";
import { createRelay } from "../src/relay/server.js";
import { decryptWebPush, selfSignedCert, type WebPushBrowserKeys } from "./lab-push-fakes.ts";

/** lab 的中继基址：.localhost 不会解析到任何公网主机 */
export const LAB_RELAY_BASE = "lab.localhost";
export const LAB_APNS_TOPIC = "cc.claudestra.lab";
const WEBPUSH_PREFIX = "/wp/";

/** lab 目录下的文件位置（scripts/sandbox-lab.ts 也用：订阅时写浏览器私钥、实测时读落盘的推送） */
export function labFiles(labRoot: string) {
  const dir = join(labRoot, "lab");
  return {
    dir, relayDb: join(dir, "relay.sqlite"), vapid: join(dir, "vapid.json"), apnsKey: join(dir, "apns-lab.p8"),
    subs: join(dir, "push-subs"), sink: join(dir, "push-sink"), pid: join(dir, "relay.pid"), log: join(dir, "relay.log"),
  };
}

/** 真推送凭据的键：lab 中继的环境里一个都不许有（脚本从零构建环境，出现了说明有人绕过脚本手动起） */
export function labRelayEnvProblems(env: Record<string, string | undefined>): string[] {
  const out = Object.keys(env).filter((k) => /^(APNS_|RELAY_APNS_|RELAY_VAPID_)/.test(k)).map((k) => `环境里有 ${k}（真推送的凭据），lab 中继不认`);
  let lab = false;
  try {
    lab = isLab(env);
  } catch (e) {
    out.push((e as Error).message);
  }
  if (!lab) out.push(`${LAB_FLAG} 不是 1（或沙箱没开）：lab 中继只由 scripts/sandbox.ts --lab 拉起`);
  for (const k of [LAB_ROOT_ENV, LAB_RELAY_PORT_ENV, LAB_PUSH_PORT_ENV, LAB_APNS_PORT_ENV]) if (!(env[k] || "").trim()) out.push(`${k} 没设`);
  return out;
}

function ensureApnsKey(path: string): void {
  if (existsSync(path)) return;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
}

let seq = 0;

/** 一条推送落盘；正文解不开也落盘（带 error），断言时看得到「收到了但解不开」 */
function record(sinkDir: string, kind: "apns" | "webpush", path: string, headers: Record<string, unknown>, text: () => string): void {
  let payload: string | null = null;
  let error: string | undefined;
  try {
    payload = text();
  } catch (e) {
    error = (e as Error).message;
  }
  const rec = { at: new Date().toISOString(), kind, path, topic: headers["apns-topic"] ?? null, payload, ...(error ? { error } : {}) };
  writeFileSync(join(sinkDir, `${Date.now()}-${String(++seq).padStart(4, "0")}-${kind}.json`), JSON.stringify(rec, null, 2) + "\n");
}

/** 假 APNs（h2）：/3/device/<token> 的正文是明文 JSON，原样落盘 */
function apnsSink(files: ReturnType<typeof labFiles>) {
  return (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      record(files.sink, "apns", req.url || "", req.headers, () => Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "apns-id": randomUUID() }).end();
    });
  };
}

/** 假 Web Push 服务：/wp/<订阅 id> 的正文用该订阅的浏览器私钥解开再落盘（私钥由 lab-push 登记时写在 lab 目录） */
async function webPushSink(files: ReturnType<typeof labFiles>, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method !== "POST" || !path.startsWith(WEBPUSH_PREFIX)) return new Response(null, { status: 404 });
  const body = new Uint8Array(await req.arrayBuffer());
  const id = path.slice(WEBPUSH_PREFIX.length).replace(/[^A-Za-z0-9_-]/g, "");
  record(files.sink, "webpush", path, {}, () => {
    const keys = JSON.parse(readFileSync(join(files.subs, `${id}.json`), "utf8")) as WebPushBrowserKeys;
    return decryptWebPush(keys, body);
  });
  return new Response(null, { status: 201 });
}

export async function runLabRelay(env: Record<string, string | undefined> = process.env): Promise<void> {
  const problems = labRelayEnvProblems(env);
  if (problems.length) {
    console.error(`❌ lab 中继拒绝启动：\n  - ${problems.join("\n  - ")}`);
    process.exit(2);
  }
  const files = labFiles(env[LAB_ROOT_ENV]!.trim());
  const relayPort = Number(env[LAB_RELAY_PORT_ENV]);
  const pushPort = Number(env[LAB_PUSH_PORT_ENV]);
  const apnsPort = Number(env[LAB_APNS_PORT_ENV]);
  for (const d of [files.dir, files.subs, files.sink]) mkdirSync(d, { recursive: true });
  const tls = await selfSignedCert(files.dir);
  ensureApnsKey(files.apnsKey);
  const webPush = Bun.serve({ port: pushPort, hostname: "127.0.0.1", tls, fetch: (req) => webPushSink(files, req) });
  const apns = http2.createSecureServer(tls, apnsSink(files));
  await new Promise<void>((ok, bad) => apns.once("error", bad).listen(apnsPort, "127.0.0.1", () => ok()));
  const sinkOrigin = `https://127.0.0.1:${pushPort}`;
  const relay = createRelay({
    base: LAB_RELAY_BASE, port: relayPort, hostname: "127.0.0.1", db: files.relayDb, version: "lab",
    push: {
      vapid: { ...loadOrCreateVapidKeys(files.vapid), subject: `mailto:lab@${LAB_RELAY_BASE}` },
      apns: { keyPath: files.apnsKey, keyId: "LABKEY0001", teamId: "LABTEAM001", topic: LAB_APNS_TOPIC, env: "sandbox" },
      allowPrivateEndpoints: true, insecureTls: true, pinEndpointOrigin: sinkOrigin,
      apnsConnect: () => http2.connect(`https://127.0.0.1:${apnsPort}`, { rejectUnauthorized: false }),
    },
  });
  writeFileSync(files.pid, `${process.pid}\n`);
  console.log(`🧪 lab 中继 ws://127.0.0.1:${relayPort}，假推送端点 ${sinkOrigin}、假 APNs :${apnsPort}（落盘到 ${files.sink}）`);
  const stop = () => {
    relay.stop();
    webPush.stop(true);
    apns.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
