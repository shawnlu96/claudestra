/**
 * project 管理命令（project-add/list/edit/remove/assign）。
 * project-migrate 与 resolveOrCreateProject / buildProjectContext 仍在 manager.ts：
 * 它们挂在 create/resume 的启动路径上（生命周期区，另一条线在改），等那边落地再一起搬。
 *
 * 从 manager.ts 逐字搬出（函数体未改，只加 export / 改相对路径）。
 */
import { readProjects, writeProjects, normalizeDir, PROJECT_ID_RE, type ProjectDef } from "../lib/projects.js";
import { bridgeRequest } from "../lib/bridge-client.js";
import { loadRegistry, saveRegistry, normalizeName, output } from "./core.js";
export async function cmdProjectAdd(
  id: string,
  opts: { name?: string; emoji?: string; dirs?: string[]; desc?: string },
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
  const dirs = (opts.dirs || []).map(normalizeDir).filter(Boolean);
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
    createdAt: new Date().toISOString(),
  };
  data.projects.push(proj);
  await writeProjects(data);
  output({ ok: true, project: proj });
}

export async function cmdProjectList() {
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

export async function cmdProjectEdit(
  id: string,
  opts: { name?: string; emoji?: string; dirs?: string[]; desc?: string },
) {
  const data = await readProjects();
  const p = data.projects.find((x) => x.id === id);
  if (!p) {
    output({ ok: false, error: `project "${id}" 不存在` });
    return;
  }
  if (opts.name !== undefined) p.name = opts.name.trim() || p.id;
  if (opts.emoji !== undefined) {
    if (opts.emoji) p.emoji = opts.emoji;
    else delete p.emoji;
  }
  if (opts.dirs !== undefined) {
    const dirs = opts.dirs.map(normalizeDir).filter(Boolean);
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
  await writeProjects(data);
  output({ ok: true, project: p });
}

export async function cmdProjectRemove(id: string) {
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

export async function cmdProjectAssign(agentName: string, projectId: string) {
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
