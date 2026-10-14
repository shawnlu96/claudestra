/**
 * runtime 别名的只读计划:看现存 runtime 目录、别名位置、socket 与 server 身份,给出「建别名 / 不动 / 拒绝」。
 * 这里只调 AliasFs 的 kind / resolve / fileId 和 ServerProbe.identify,不写任何东西。tests/floka-runtime.test.ts。
 */

import { basename, dirname, isAbsolute, join, resolve, sep } from "path";
import type { AliasFs, AliasState, Refusal, RuntimeAliasInput, RuntimeAliasPlan } from "./types.ts";

const errCode = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? "");

const refusal = (code: Refusal["code"], scope: Refusal["scope"], detail: string): Refusal => ({ code, scope, detail });

/** 解析软链;解析不了返回错误码(ENOENT = 失效,ELOOP = 成环) */
async function tryResolve(fs: AliasFs, path: string): Promise<{ path: string; error?: undefined } | { error: string }> {
  try {
    return { path: await fs.resolve(path) };
  } catch (e) {
    return { error: errCode(e) || "UNKNOWN" };
  }
}

function inputProblem(i: RuntimeAliasInput): Refusal | undefined {
  for (const [label, p] of [["现存 runtime 目录", i.currentDir], ["别名路径", i.aliasDir]] as const) {
    if (typeof p !== "string" || !isAbsolute(p)) return refusal("invalid-path", "path", `${label}必须是显式绝对路径(收到 ${JSON.stringify(p)})`);
  }
  const n = i.socketName;
  if (typeof n !== "string" || !n || n === "." || n === ".." || n !== basename(n)) {
    return refusal("invalid-path", "path", `socket 文件名必须是单个文件名(收到 ${JSON.stringify(n)})`);
  }
  return undefined;
}

/** 现存 runtime 目录解析到的真实目录;不存在、解析不了或不是目录就拒绝 */
async function inspectCurrent(fs: AliasFs, currentDir: string): Promise<{ real: string; refusal?: undefined } | { refusal: Refusal }> {
  if ((await fs.kind(currentDir)) === "missing") return { refusal: refusal("current-missing", "path", `现存 runtime 目录不存在:${currentDir}`) };
  const got = await tryResolve(fs, currentDir);
  if (got.error !== undefined) return { refusal: refusal("current-missing", "path", `现存 runtime 目录解析不了(${got.error}):${currentDir}`) };
  if ((await fs.kind(got.path)) !== "dir") return { refusal: refusal("current-not-dir", "path", `现存 runtime 路径不是目录:${got.path}`) };
  return { real: got.path };
}

/** 别名位置与真实目录重合或互相嵌套的拒绝(按别名父目录解析软链后的位置比) */
async function placementProblem(fs: AliasFs, aliasDir: string, currentReal: string): Promise<Refusal | undefined> {
  const parent = await tryResolve(fs, dirname(aliasDir));
  if (parent.error !== undefined) return refusal("alias-parent-missing", "path", `别名的父目录不存在或解析不了(${parent.error}):${dirname(aliasDir)}`);
  const at = join(parent.path, basename(aliasDir));
  if (at === currentReal) return refusal("same-path", "path", `别名路径就是现存 runtime 目录本身:${aliasDir}`);
  if (at.startsWith(currentReal + sep) || currentReal.startsWith(at + sep)) {
    return refusal("nested-path", "path", `别名路径与现存 runtime 目录互相嵌套:${aliasDir} ↔ ${currentReal}`);
  }
  return undefined;
}

async function inspectAlias(fs: AliasFs, aliasDir: string, currentReal: string): Promise<{ state: AliasState; refusal?: Refusal }> {
  const kind = await fs.kind(aliasDir);
  if (kind === "missing") return { state: "absent" };
  if (kind !== "symlink") {
    const what = kind === "dir" ? "目录" : "文件";
    return { state: "conflict-entry", refusal: refusal("conflict-entry", "alias", `别名路径已被真实${what}占用,不覆盖:${aliasDir}`) };
  }
  const got = await tryResolve(fs, aliasDir);
  if (got.error === "ELOOP") return { state: "alias-loop", refusal: refusal("alias-loop", "alias", `别名的软链成环:${aliasDir}`) };
  if (got.error !== undefined) {
    return { state: "dangling-alias", refusal: refusal("dangling-alias", "alias", `别名是失效软链(${got.error}),目标已不存在,不自动替换:${aliasDir}`) };
  }
  if (got.path === currentReal) return { state: "aliased" };
  return { state: "wrong-alias", refusal: refusal("wrong-alias", "alias", `别名指向别处,不改写:${aliasDir} → ${got.path}`) };
}

/**
 * 经 dir 这条路径看到的 server 身份 = probe 给的 server 标识 + socket 文件标识(dev:ino)。
 * 两段都要一致才算同一个 server:别名后面若是另一份 socket 文件,文件标识就对不上。
 */
export async function socketIdentity(i: Pick<RuntimeAliasInput, "fs" | "probe" | "socketName">, dir: string): Promise<string | null> {
  const socket = join(dir, i.socketName);
  const file = await i.fs.fileId(socket);
  if (file === null) return null;
  const server = await i.probe.identify(socket);
  return server === null ? null : `${server}@${file}`;
}

async function inspectServer(i: RuntimeAliasInput, currentDir: string): Promise<{ identity: string | null; refusal?: Refusal }> {
  const socket = join(currentDir, i.socketName);
  if ((await i.fs.fileId(socket)) === null) return { identity: null, refusal: refusal("socket-missing", "server", `现存 runtime 目录里没有 socket:${socket}`) };
  const identity = await socketIdentity(i, currentDir);
  if (identity !== null) return { identity };
  return { identity, refusal: refusal("server-unreachable", "server", `socket 后面查不到 server,无法核对身份(本库不启动 server):${socket}`) };
}

/** 物理落点切换(把真实目录搬到别名位置)的步骤,留维护窗口人工做;本库只输出 */
function maintenancePlan(currentReal: string, aliasDir: string, socketName: string): string[] {
  return [
    `导出现存 server 的窗口清单并记下 server 身份(经 ${join(aliasDir, socketName)} 查询)`,
    "停掉所有 daemon,确认没有进程正在经旧路径建连",
    `去掉别名 ${aliasDir},把真实目录 ${currentReal} 整体改名到 ${aliasDir}(同一文件系统内改名,socket 文件不变、不复制、不重启 server)`,
    `在旧位置 ${currentReal} 建反向别名指向 ${aliasDir},再查一次 server 身份,必须与切换前相同`,
    "runtime 目录设置改指新路径后全量重启 daemon;tmux server 的全局环境仍是旧值,抽样核对环境传播",
    "回退:去掉反向别名,把目录改名回原位置,重建本库的别名",
  ];
}

function emptyPlan(i: RuntimeAliasInput, refusals: Refusal[]): RuntimeAliasPlan {
  return {
    currentDir: i.currentDir, currentReal: "", aliasDir: i.aliasDir, currentSocket: "", aliasSocket: "",
    aliasState: "unknown", action: "none", identity: null, refusals, maintenance: [],
  };
}

/** 只读出计划:任何模式下都不写。拒绝项列在 refusals 里,为空且别名不存在时 action = create-alias */
export async function planRuntimeAlias(i: RuntimeAliasInput): Promise<RuntimeAliasPlan> {
  const bad = inputProblem(i);
  if (bad) return emptyPlan(i, [bad]);
  const [currentDir, aliasDir] = [resolve(i.currentDir), resolve(i.aliasDir)];
  const base = { ...emptyPlan(i, []), currentDir, aliasDir, currentSocket: join(currentDir, i.socketName), aliasSocket: join(aliasDir, i.socketName) };
  const current = await inspectCurrent(i.fs, currentDir);
  if (current.refusal) return { ...base, refusals: [current.refusal] };
  const plan: RuntimeAliasPlan = { ...base, currentReal: current.real, maintenance: maintenancePlan(current.real, aliasDir, i.socketName) };
  const placement = await placementProblem(i.fs, aliasDir, current.real);
  if (placement) return { ...plan, refusals: [placement] };
  const alias = await inspectAlias(i.fs, aliasDir, current.real);
  const server = await inspectServer(i, currentDir);
  const refusals = [alias.refusal, server.refusal].filter((r): r is Refusal => r !== undefined);
  return { ...plan, aliasState: alias.state, identity: server.identity, refusals, action: !refusals.length && alias.state === "absent" ? "create-alias" : "none" };
}
