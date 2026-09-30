/**
 * project 管理命令（project-add/list/edit/remove/assign/merge），manager.ts 的 switch 整组交给 runProjectCommand。
 * project-migrate 与 resolveOrCreateProject / buildProjectContext 仍在 manager.ts：
 * 它们挂在 create/resume 的启动路径上（生命周期区，另一条线在改），等那边落地再一起搬。
 *
 * 从 manager.ts 搬出；能改目录归属的 add / edit --dirs / merge 另有目录校验（lib/project-dirs.ts）和角色校验（project-guard.ts）。
 */
import { readProjects, writeProjects, PROJECT_ID_RE, type ProjectDef } from "../lib/projects.js";
import { validateProjectDirs } from "../lib/project-dirs.js";
import { bridgeRequest } from "../lib/bridge-client.js";
import { loadRegistry, saveRegistry, normalizeName, output } from "./core.js";
import { requireOwnerOrMaster, requireProjectWriter } from "./project-guard.js";

async function cmdProjectAdd(
  id: string,
  opts: ProjectFlags,
) {
  if (!PROJECT_ID_RE.test(id)) {
    output({ ok: false, error: `project id 需匹配 ${PROJECT_ID_RE}(小写字母数字/-/_,≤32): "${id}"` });
    return;
  }
  const data = await readProjects();
  if (data.projects.some((p) => p.id === id)) {
    output({ ok: false, error: `project "${id}" 已存在` });
    return;
  }
  const checked = validateProjectDirs(opts.dirs || [], data.projects, id);
  if (!checked.ok) return output(checked);
  const dirs = checked.dirs;
  if (dirs.length === 0) {
    output({ ok: false, error: "至少要一个工作目录: --dirs <a,b>" });
    return;
  }
  const proj: ProjectDef = {
    id,
    name: opts.name?.trim() || id,
    ...(opts.emoji ? { emoji: opts.emoji } : {}),
    dirs,
    ...(opts.desc ? { description: opts.desc } : {}),
    ...(opts.personal ? { personal: true } : {}),
    createdAt: new Date().toISOString(),
  };
  data.projects.push(proj);
  await writeProjects(data);
  output({ ok: true, project: proj });
}

async function cmdProjectList() {
  const data = await readProjects();
  const reg = await loadRegistry();
  const projects = data.projects.map((p) => ({
    ...p,
    agents: Object.entries(reg.agents)
      .filter(([, a]) => a.projectId === p.id)
      .map(([n, a]) => ({ name: n, status: a.status, purpose: a.purpose || "" })),
  }));
  // 未归属的 agent 一并透出——UI 的「未分组」提示 + 迁移遗漏排查
  const unassigned = Object.entries(reg.agents)
    .filter(([, a]) => !a.projectId)
    .map(([n]) => n);
  output({ ok: true, projects, unassigned });
}

async function cmdProjectEdit(
  id: string,
  opts: ProjectFlags,
) {
  const data = await readProjects();
  const p = data.projects.find((x) => x.id === id);
  if (!p) {
    output({ ok: false, error: `project "${id}" 不存在` });
    return;
  }
  const oldName = p.name;
  if (opts.name !== undefined) p.name = opts.name.trim() || p.id;
  if (opts.emoji !== undefined) {
    if (opts.emoji) p.emoji = opts.emoji;
    else delete p.emoji;
  }
  if (opts.dirs !== undefined) {
    const checked = validateProjectDirs(opts.dirs, data.projects, id);
    if (!checked.ok) return output(checked);
    const dirs = checked.dirs;
    if (dirs.length === 0) {
      output({ ok: false, error: "目录列表不能为空(project 至少要有一个工作目录)" });
      return;
    }
    p.dirs = dirs;
  }
  if (opts.desc !== undefined) {
    if (opts.desc) p.description = opts.desc;
    else delete p.description;
  }
  if (opts.personal === true) p.personal = true;
  else if (opts.personal === false) delete p.personal;
  await writeProjects(data);
  if (p.name !== oldName) await renameProjectCategory(id, oldName, p.name);
  output({ ok: true, project: p });
}

/**
 * 改名同步 Discord category：原地改名（保住位置和权限覆盖），成员频道本来就在里面；改完后续成员只是确认一下归属。
 * 以前改名后 category 还叫旧名，下一个 project-assign 进来的 agent 会另建一个新名字的 category（台账 i08 1.2）。
 */
async function renameProjectCategory(id: string, from: string, to: string) {
  const reg = await loadRegistry();
  for (const a of Object.values(reg.agents)) {
    if (a.projectId !== id || !a.channelId) continue;
    await bridgeRequest({ type: "move_channel", channelId: a.channelId, category: to, renameFrom: from }).catch((e: Error) => {
      console.error(`project 改名：Discord category 没跟上（bridge 离线 / web-only 时正常，下次 project-assign 会补）: ${e.message}`);
    });
  }
}

async function cmdProjectRemove(id: string) {
  const data = await readProjects();
  if (!data.projects.some((p) => p.id === id)) {
    output({ ok: false, error: `project "${id}" 不存在` });
    return;
  }
  const reg = await loadRegistry();
  const members = Object.entries(reg.agents)
    .filter(([, a]) => a.projectId === id)
    .map(([n]) => n);
  if (members.length > 0) {
    output({
      ok: false,
      error: `project "${id}" 还有 ${members.length} 个 agent(${members.join(", ")})。先 project-assign 移走或 kill+remove,再删。`,
    });
    return;
  }
  data.projects = data.projects.filter((p) => p.id !== id);
  await writeProjects(data);
  output({ ok: true, removed: id });
}

async function cmdProjectAssign(agentName: string, projectId: string) {
  const tmuxName = normalizeName(agentName);
  const data = await readProjects();
  const proj = data.projects.find((p) => p.id === projectId);
  if (!proj) {
    output({ ok: false, error: `project "${projectId}" 不存在。已有: ${data.projects.map((p) => p.id).join(", ") || "(无)"}` });
    return;
  }
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) {
    output({ ok: false, error: `agent "${tmuxName}" 不在 registry` });
    return;
  }
  const from = info.projectId;
  info.projectId = projectId;
  await saveRegistry(reg);
  // Phase 3:Discord 频道挪到 project 对应 category(web-only / bridge 离线时静默跳过)
  if (info.channelId) {
    await bridgeRequest({ type: "move_channel", channelId: info.channelId, category: proj.name }).catch(() => {});
  }
  output({ ok: true, agent: tmuxName, from: from || null, to: projectId });
}

type ProjectFlags = { name?: string; emoji?: string; dirs?: string[]; desc?: string; personal?: boolean; personalBad?: string };

/** --name / --emoji / --dirs / --desc / --personal on|off；edit 时空值 = 清掉（emptyClears），add 时空值 = 没给 */
function parseProjectFlags(args: string[], emptyClears: boolean): { opts: ProjectFlags; pos: string[] } {
  const opts: ProjectFlags = {};
  const pos: string[] = [];
  const val = (i: number) => (emptyClears ? args[i] ?? "" : args[i]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name") opts.name = val(++i);
    else if (a === "--emoji") opts.emoji = val(++i);
    else if (a === "--dirs") opts.dirs = (args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--desc") opts.desc = val(++i);
    else if (a === "--personal") {
      const v = args[++i];
      if (v === "on" || v === "off") opts.personal = v === "on";
      else opts.personalBad = v ?? "";
    } else pos.push(a);
  }
  return { opts, pos };
}

const USAGE: Record<string, string> = {
  "project-add": "project-add <id> --dirs <a,b> [--name <显示名>] [--emoji <e>] [--desc <说明>] [--personal on|off]",
  "project-edit": "project-edit <id> [--name <显示名>] [--emoji <e>] [--dirs <a,b>] [--desc <说明>] [--personal on|off]",
  "project-remove": "project-remove <id>(须先清空成员)",
  "project-assign": "project-assign <agent> <projectId>",
  "project-merge": "project-merge <src> <dst>(目录并进 dst、成员挪过去、删 src)",
};

/** manager.ts 的 project-* 分支（add/list/edit/remove/assign/merge） */
export async function runProjectCommand(cmd: string, args: string[]): Promise<void> {
  if (cmd === "project-list") return cmdProjectList();
  const { opts, pos } = parseProjectFlags(args, cmd === "project-edit");
  const [a, b] = cmd === "project-add" || cmd === "project-edit" ? pos : args;
  const need2 = cmd === "project-assign" || cmd === "project-merge";
  if (!a || (need2 && !b) || opts.personalBad !== undefined) {
    output({ ok: false, error: USAGE[cmd] ?? `unknown ${cmd}` });
    return;
  }
  // 能改目录归属的三个命令只许 owner / master / 目标项目的 PM（merge 要两边都是）（project-guard.ts）
  if (cmd === "project-add" || cmd === "project-merge" || (cmd === "project-edit" && opts.dirs !== undefined)) {
    const denied = await requireProjectWriter(cmd === "project-merge" ? [a, b] : [a]);
    if (denied) return output({ ok: false, code: "forbidden", ...denied });
  }
  // 个人项目永不外借（lib/lend-policy.ts）：取消这个标记等于放开外借，只许 owner / master
  if (cmd === "project-edit" && opts.personal === false) {
    const denied = await requireOwnerOrMaster("取消个人项目标记");
    if (denied) return output({ ok: false, code: "forbidden", ...denied });
  }
  if (cmd === "project-add") return cmdProjectAdd(a, opts);
  if (cmd === "project-edit") return cmdProjectEdit(a, opts);
  if (cmd === "project-remove") return cmdProjectRemove(a);
  if (cmd === "project-assign") return cmdProjectAssign(a, b);
  if (cmd === "project-merge") return cmdProjectMerge(a, b);
}

/**
 * 把 src 并进 dst（台账 i08 1.1）：目录并进去（按真实路径去重，照 add 校验绝对路径）、成员 projectId 改成 dst 并把 Discord 频道挪到 dst 的 category、删 src。
 * 旧 category 空了留在 Discord（bridge 没有删分类的通道），输出里报出来。合不合、合哪几个是 owner 拍板的事，这里只提供工具。
 */
async function cmdProjectMerge(srcId: string, dstId: string) {
  const data = await readProjects();
  const src = data.projects.find((p) => p.id === srcId);
  const dst = data.projects.find((p) => p.id === dstId);
  if (!src || !dst || src === dst) {
    output({ ok: false, error: !src ? `project "${srcId}" 不存在` : !dst ? `project "${dstId}" 不存在` : "src 和 dst 是同一个" });
    return;
  }
  // 合并后的目录照 add / edit 一样校验（绝对路径、不和第三个项目撞）；src 要删掉，不算撞
  const checked = validateProjectDirs([...dst.dirs, ...src.dirs], data.projects.filter((p) => p.id !== srcId), dstId);
  if (!checked.ok) return output(checked);
  dst.dirs = checked.dirs;
  if (src.personal) dst.personal = true; // 个人项目的目录并进来，合并后的项目也得是个人项目，否则等于放开外借
  const reg = await loadRegistry();
  const moved = Object.entries(reg.agents).filter(([, a]) => a.projectId === srcId);
  for (const [, a] of moved) a.projectId = dstId;
  await saveRegistry(reg);
  data.projects = data.projects.filter((p) => p.id !== srcId);
  await writeProjects(data);
  for (const [n, a] of moved) {
    if (!a.channelId) continue;
    await bridgeRequest({ type: "move_channel", channelId: a.channelId, category: dst.name }).catch((e: Error) => {
      console.error(`project-merge：${n} 的 Discord 频道没挪成（bridge 离线 / web-only 时正常，下次 project-assign 会补）: ${e.message}`);
    });
  }
  output({ ok: true, merged: srcId, into: dstId, moved: moved.map(([n]) => n), dirs: dst.dirs, emptyCategory: moved.length ? src.name : null });
}
