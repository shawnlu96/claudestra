/**
 * `bun run sandbox pi-auth <provider>`：把**一家** provider 的 API key 从 owner 的 Pi 目录拷进沙箱的 Pi 目录（docs/architecture/pi-acp-sandbox.md）。
 * 沙箱的 Pi 默认没有任何凭据（HOME 与 PI_CODING_AGENT_DIR 都在沙箱根下，provider 的 key 变量不继承），要跑真模型只有这条显式的路。
 * - 源只读：<PI_CODING_AGENT_DIR 或 ~/.pi/agent>/auth.json 的同名条目、models.json 的同名 provider 块；
 * - 只拷字面的 API key：OAuth 不拷（沙箱里一刷新就轮换 refresh token，owner 那份登录随之失效）；`!命令` 不拷（会在沙箱里跑命令取 key）；
 * - 写沙箱 <root>/pi-agent/{auth,models}.json：目录不许是链接、真实路径在根下、强制 0700；文件唯一名排他创建、强制 0600、原子 rename，
 *   已有的目标是链接就拒（lib/sandbox-pi-fs.ts）；输出只有 provider 名和路径，不含 key。
 * 只能从沙箱外的 shell 跑：沙箱 agent 自己的 Bash 带着沙箱环境，不能替 owner 做这个决定。tests/pi-acp-sandbox.test.ts。
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piAgentDir } from "../src/lib/pi-session.js";
import { isSandbox, sandboxPiAgentDir } from "../src/lib/sandbox.js";
import { ensurePrivateDir, piStateDirProblem, writePrivateFile } from "../src/lib/sandbox-pi-fs.js";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
/** 任何一个字符串值以 ! 开头 = pi 会把它当命令执行（auth.json 的 key、models.json 的 apiKey / headers） */
const hasCommand = (v: unknown): boolean =>
  typeof v === "string" ? v.trimStart().startsWith("!") : isObj(v) || Array.isArray(v) ? Object.values(v).some(hasCommand) : false;

/** 从 owner 的两份文件里挑出这一家能拷的部分；挑不出或不许拷返回原因（原因里不带任何值） */
export function pickPiCredential(provider: string, auth: Json, models: Json): { auth?: Json; model?: Json } | { error: string } {
  const own = (o: unknown) => (isObj(o) && Object.hasOwn(o, provider) ? o[provider] : undefined); // 原型上的 constructor 之类不算
  const a = own(auth);
  const m = own(models.providers);
  if (a === undefined && m === undefined) return { error: `owner 的 Pi 目录里没有 provider「${provider}」（auth.json / models.json 都没有）` };
  if (a !== undefined) {
    if (!isObj(a) || a.type !== "api_key") return { error: `「${provider}」在 auth.json 里不是 API key（OAuth 不拷：沙箱里刷新会轮换 token，owner 的登录就失效了）` };
    if (typeof a.key !== "string" || !a.key.trim()) return { error: `「${provider}」在 auth.json 里没有 key` };
  }
  if (m !== undefined && !isObj(m)) return { error: `「${provider}」在 models.json 里不是对象` };
  if (hasCommand(a) || hasCommand(m)) return { error: `「${provider}」的凭据是 !命令 形式：拷进沙箱会在沙箱里执行它，不拷` };
  return { ...(a !== undefined ? { auth: a as Json } : {}), ...(m !== undefined ? { model: m as Json } : {}) };
}

/** 不存在 = 空对象；坏文件抛只带路径的错（JSON.parse 的原始报错会引用文件里的片段，可能就是 key） */
function readJson(path: string): Json {
  if (!existsSync(path)) return {};
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    v = null; // 原始报错不往外带，统一按下面「不是 JSON 对象」报
  }
  if (!isObj(v)) throw new Error(`${path} 不是合法的 JSON 对象`);
  return v;
}

/** 沙箱里已有的目标文件：是链接就拒（读它会把根外文件的内容合并进来），不存在 = 空对象 */
function readTarget(path: string): Json {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`${path} 不是普通文件（链接？），不读也不覆盖`);
  return readJson(path);
}

const writeSecret = (path: string, data: Json) => writePrivateFile(path, `${JSON.stringify(data, null, 2)}\n`);

/** 拷一家进 dst（与已拷进来的别家合并）；返回写了的文件。root = 沙箱根，dst 必须是它下面的真实目录 */
export function copyPiCredential(provider: string, srcDir: string, dstDir: string, root = dirname(dstDir)): { written: string[] } | { error: string } {
  let picked: ReturnType<typeof pickPiCredential>;
  try {
    picked = pickPiCredential(provider, readJson(join(srcDir, "auth.json")), readJson(join(srcDir, "models.json")));
  } catch (e) {
    return { error: (e as Error).message };
  }
  if ("error" in picked) return picked;
  const dirProblem = piStateDirProblem(root, dstDir);
  if (dirProblem) return { error: dirProblem };
  const written: string[] = [];
  try {
    ensurePrivateDir(dstDir);
    if (picked.auth) {
      const p = join(dstDir, "auth.json");
      writeSecret(p, { ...readTarget(p), [provider]: picked.auth });
      written.push(p);
    }
    if (picked.model) {
      const p = join(dstDir, "models.json");
      const cur = readTarget(p);
      writeSecret(p, { ...cur, providers: { ...(isObj(cur.providers) ? cur.providers : {}), [provider]: picked.model } });
      written.push(p);
    }
  } catch (e) {
    return { error: (e as Error).message }; // 报错只带路径：readJson / 本模块的错都不引用文件内容
  }
  return { written };
}

/** scripts/sandbox.ts 的 pi-auth 子命令；marker = 沙箱根的标记检查结果（不是本脚本建的沙箱就拒） */
export function cmdPiAuth(args: string[], root: string, marker: string | null, fail: (msg: string) => never): void {
  if (isSandbox()) fail("pi-auth 要从沙箱外的 shell 跑：它读 owner 的 Pi 凭据，沙箱里的进程不能替 owner 做这个决定");
  if (marker) fail(marker);
  const provider = args[0] ?? "";
  if (!/^[\w.-]+$/.test(provider) || args.length !== 1) fail("用法：bun run sandbox pi-auth <provider> [--port N | --root DIR]（一次一家）");
  const r = copyPiCredential(provider, piAgentDir(), sandboxPiAgentDir(root), root);
  if ("error" in r) fail(r.error);
  console.log(`🔑 已把「${provider}」的凭据拷进沙箱（不打印 key）：${r.written.join("、")}；sandbox clean 会连它一起删`);
}
