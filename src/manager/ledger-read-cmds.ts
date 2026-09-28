/**
 * `ledger` 的读子命令与项目设置：whoami / show / export / meta / ask-check。
 * export 不直接拷 WAL 库文件（正在写的库拷出来可能缺最近的提交）：JSON 走一致读，整库走 VACUUM INTO。
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { checkAsk, paramsHash } from "../lib/ask-bind.js";
import { getAsk, hasAsksTable } from "../lib/ledger-asks.js";
import { taskMetrics } from "../lib/ledger-metrics.js";
import { getItem, getMeta, getTask, LedgerError, listEvents, listItems, listTasks } from "../lib/ledger-store.js";
import { setMeta } from "../lib/ledger-write.js";
import { isUmbrellaDir, normalizeDir } from "../lib/projects.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { agentKey, intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const DEFAULT_EVENTS = 20;

function whoami(c: LedgerCli): Result {
  const project = c.p.flags.project ?? c.deps.actorProject ?? null;
  return { ok: true, actor: c.deps.actor, project, role: project ? c.role(project) : null };
}

/** 不带目标：项目总览（任务附指标）；任务：详情 + 指标 + 最近事件；事项：详情 + 挂着的任务 + 最近事件 */
function show(c: LedgerCli): Result {
  const id = c.p.pos[1];
  const limit = intFlag(c.p, "events") ?? DEFAULT_EVENTS;
  const now = c.deps.now();
  const task = id ? getTask(c.db, id) : null;
  if (task) {
    const events = listEvents(c.db, { target: task.id });
    return { ok: true, task, metrics: taskMetrics(task, events, now), events: events.slice(-limit) };
  }
  const project = c.project();
  if (id) {
    const item = getItem(c.db, project, id);
    if (!item) throw new LedgerError("not_found", `项目 ${project} 里没有任务或事项 ${id}`);
    const tasks = listTasks(c.db, project).filter((t) => t.itemId === id);
    return { ok: true, item, tasks, events: listEvents(c.db, { project, target: id }).slice(-limit) };
  }
  const events = listEvents(c.db, { project });
  const tasks = listTasks(c.db, project).map((t) => ({ ...t, metrics: taskMetrics(t, events, now) }));
  return { ok: true, project, meta: getMeta(c.db, project), items: listItems(c.db, project), tasks };
}

function exportCmd(c: LedgerCli): Result {
  const out = c.p.flags.out;
  const sqlite = c.p.flags.sqlite;
  if (!out === !sqlite) throw new LedgerError("invalid", "export 要带 --out <file.json>（单个项目）或 --sqlite <file>（整库）其中一个");
  const dest = (out ?? sqlite) as string;
  if (sqlite) {
    // VACUUM INTO 自己拒绝写到已存在的非空文件，不覆盖的判断交给 sqlite（先查再写有竞态）
    try {
      c.db.prepare("VACUUM INTO ?").run(dest);
    } catch (e) {
      throw new LedgerError(existsSync(dest) ? "conflict" : "invalid", `导出到 ${dest} 失败：${(e as Error).message}`);
    }
    return { ok: true, sqlite: dest };
  }
  const project = c.project();
  // 一个读事务里取完：别的进程在中途写入时，items / tasks / events 仍是同一刻的快照
  const data = c.db.transaction(() => ({
    project, exportedAt: new Date(c.deps.now()).toISOString(), meta: getMeta(c.db, project),
    items: listItems(c.db, project), tasks: listTasks(c.db, project), events: listEvents(c.db, { project }),
  }))();
  try {
    writeFileSync(dest, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new LedgerError(code === "EEXIST" ? "conflict" : "invalid", code === "EEXIST" ? `${dest} 已存在，不覆盖` : `写 ${dest} 失败：${(e as Error).message}`);
  }
  return { ok: true, out: dest, items: data.items.length, tasks: data.tasks.length, events: data.events.length };
}

/**
 * docsDir 存 realpath 后的绝对路径：~ 展开、相对路径拒绝（会随调用时的 cwd 变）、目录必须已存在。
 * 大伞目录（/、家目录、临时目录，以及家目录的上级如 /Users）一律拒绝——docs 端点只按「根 + 分隔符」比前缀，
 * 根设得太大就等于把整台机器的 .md / 图片开放给读台账的设备（T8c 审查的纵深防御）。
 */
export function expandDocsDir(raw: string, home = homedir()): string {
  const p = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(p)) throw new LedgerError("invalid", `--docs-dir 要是绝对路径（或 ~/ 开头）：${raw}`);
  let real: string;
  try {
    real = realpathSync(p);
  } catch (e) {
    throw new LedgerError("invalid", `--docs-dir 读不到（要先建好目录）：${p}（${(e as Error).message}）`);
  }
  const homeReal = realpathSync(home);
  const umbrella = [real, normalizeDir(p)].some(isUmbrellaDir) || real === homeReal || homeReal.startsWith(`${real}/`) || real === "/";
  if (umbrella) throw new LedgerError("invalid", `--docs-dir 不能是 /、家目录、临时目录或家目录的上级这类大目录：${real}`);
  return real;
}

/** 不带参数 = 查看；--pms / --docs-dir 只有 owner 能设（库里判） */
function meta(c: LedgerCli): Result {
  const project = c.project();
  const { pms, "docs-dir": docsDir } = c.p.flags;
  if (pms === undefined && docsDir === undefined) return { ok: true, project, meta: getMeta(c.db, project) };
  const ctx = { actor: c.deps.actor, now: c.deps.now() };
  if (pms !== undefined) {
    const list = pms.split(",").map((s) => s.trim()).filter(Boolean).map(agentKey);
    setMeta(c.db, ctx, { project, key: "pms", value: list });
  }
  if (docsDir !== undefined) setMeta(c.db, ctx, { project, key: "docsDir", value: expandDocsDir(docsDir) });
  return { ok: true, project, meta: getMeta(c.db, project) };
}

/**
 * `ledger ask-check <askId> --hash <h> | --params '<json>'`（docs 13 §4.7）：授权类 ask 批下来的是不是这组参数。agent 执行前跑，
 * 退出码非 0 = 别执行、重新问（reason 说为什么）。--params 由这里现算哈希（和 reply 结果里回的 askHash 同一个算法，lib/ask-bind.ts）
 */
function askCheck(c: LedgerCli): Result {
  const id = c.p.pos[1];
  const { hash, params } = c.p.flags;
  if (!id || (hash === undefined) === (params === undefined)) throw new LedgerError("invalid", "ask-check <askId> 要带 --hash <h> 或 --params '<json>' 其中一个");
  let h = hash ?? "";
  if (params !== undefined) {
    try {
      h = paramsHash(JSON.parse(params));
    } catch (e) {
      throw new LedgerError("invalid", `--params 不是 JSON：${(e as Error).message}`);
    }
  }
  const r = checkAsk(hasAsksTable(c.db) ? getAsk(c.db, id) : null, h, c.deps.now());
  return r.ok ? { ok: true, askId: id, approved: true } : { ok: false, code: "conflict", askId: id, approved: false, error: r.reason };
}

export const READ_CMDS: Record<string, CommandSpec> = {
  whoami: { valued: ["project"], usage: "whoami", run: whoami },
  show: { valued: ["events", "project"], usage: "show [<task|item>] [--events N]", run: show },
  export: { valued: ["out", "sqlite", "project"], usage: "export --out <file.json> | --sqlite <file>", run: exportCmd },
  meta: { valued: ["pms", "docs-dir", "project"], usage: "meta [--pms a,b] [--docs-dir <path>]（不带参数 = 查看）", run: meta },
  "ask-check": { valued: ["hash", "params", "project"], usage: "ask-check <askId> --hash <h> | --params '<json>'（授权类 ask 执行前核对，非 0 = 别执行）", run: askCheck },
};
