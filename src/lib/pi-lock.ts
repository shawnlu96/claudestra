/**
 * Pi 全局模型锁：Pi agent 一律用这里给的模型 + 档位，忽略 create / registry 传入的值；tmux 与 ACP 两条启动路径都读它。
 * 值来自 config.json 的 piLockedModel / piLockedEffort，只由 owner 改，下次启动 Pi 生效；没写（或文件缺失 / 损坏，损坏会报错日志）用 pi-launch.ts 的默认值。
 * 写了但不合法就抛错、Pi 不启动：静默回落会让 owner 以为改动生效了，放开锁更不行。测试：tests/pi-lock.test.ts。
 */
import { CONFIG_PATH } from "./paths.js";
import { PI_LOCKED_EFFORT, PI_LOCKED_MODEL, PI_THINKING_LEVELS, isPiThinkingLevel } from "./pi-launch.js";
import { readJsonStateSync, reportCorrupt } from "./state-file.js";

export interface PiLock { model: string; effort: string }

// provider/model：首字符字母数字（挡 -x 被当 flag），只许 id 字符，最长 128；会拼进启动参数和宿主环境变量
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]*\/[A-Za-z0-9._\/@:-]+$/;

/** raw = config.json 解析后的对象；不传就现读文件 */
export function piLock(raw: unknown = readRawConfig()): PiLock {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const m = o.piLockedModel, e = o.piLockedEffort;
  if (m !== undefined && (typeof m !== "string" || m.length > 128 || !MODEL_RE.test(m))) {
    throw new Error(`config.json 的 piLockedModel 不合法（${JSON.stringify(m)}）：要写成 provider/model，例如 ${PI_LOCKED_MODEL}；Pi 不启动`);
  }
  if (e !== undefined && (typeof e !== "string" || !isPiThinkingLevel(e))) {
    throw new Error(`config.json 的 piLockedEffort 不合法（${JSON.stringify(e)}）：可用 ${PI_THINKING_LEVELS.join(" / ")}；Pi 不启动`);
  }
  return { model: m ?? PI_LOCKED_MODEL, effort: e ?? PI_LOCKED_EFFORT };
}

/** 缺失 → 没配；损坏 / 读不了（EACCES 等）→ 报出来再用默认锁（仍是锁住的）：这条路不一定经过 config-store，不能指望它替我们报 */
export function readRawConfig(path = CONFIG_PATH): unknown {
  const r = readJsonStateSync(path);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "pi-lock：按默认锁启动 Pi");
  return r.status === "ok" ? r.data : undefined;
}
