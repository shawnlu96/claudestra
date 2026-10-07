import { ProjectFailure, type ProjectCard, type ProjectSnapshot } from "./shared-projects-model";
import { list, object, parseProjectSnapshot, text } from "./shared-projects-parse";
import { projectChoice } from "./shared-projects-choice";

/** Project only N4's public snapshot into the existing UI model; canonical center validation stays in N4/N1C. */
export function projectSourceSnapshot(value: unknown): ProjectSnapshot {
  const data = object(value), who = object(data.identity);
  if (data.v !== 1 || who.subject !== "owner:self" || who.kind !== "person") throw new ProjectFailure(502);
  const centerId = text(who.centerId), teamId = text(who.teamId), personId = text(who.personId), instanceId = text(who.instanceId);
  const locals = list(data.localProjects, v => object(v));
  const projects = list(data.projects, v => {
    const p = object(v), role = object(p.projectRole), ids = list(p.localProjectIds, v => text(v, 32));
    if (p.centerId !== centerId || p.teamId !== teamId || ids.length > 1) throw new ProjectFailure(502);
    const local = ids.length ? locals.filter(l => l.id === ids[0]) : [];
    if (local.length > 1) throw new ProjectFailure(502);
    return { centerId, teamId, projectId: p.projectId, name: p.name, rev: p.rev, status: p.status,
      role: role.available === true ? role.value : null, local: local[0] ?? null,
      availability: local.length && role.available === true ? "ready" : "pending" };
  });
  const role = object(data.teamRole), capabilities = object(data.capabilities);
  const snapshot = parseProjectSnapshot({ teams: [{ centerId, teamId, personId, name: "团队（显示名未提供）",
    teamRole: role.available === true ? role.value : null }], projects,
    localProjects: locals.map(p => {
      if (typeof p.eligible !== "boolean") throw new ProjectFailure(502);
      return { id: p.id, name: p.name, personal: p.personal, bound: !p.eligible };
    }),
    peers: list(data.peers, v => object(v)).filter(p => p.enabled === true && p.invitable === true).map(p => ({ id: p.name, name: p.name })),
  });
  return { ...snapshot,
    projects: snapshot.projects.map(p => ({ ...p, personId, instanceId })),
    capabilities: { invite: object(capabilities.invite).available === true, leave: object(capabilities.leave).available === true } };
}

/** Read only N4/N3's public card surface. Never carry bind.params, body, invitation codes or arbitrary response extras into React. */
export function projectSourceCards(value: unknown, now = Date.now()): ProjectCard[] {
  return list(object(value).asks, v => {
    const a = object(v);
    if (a.state !== "open" || !Number.isSafeInteger(a.expiresAt) || Number(a.expiresAt) <= now) return null;
    const ids = a.createdBy === "system:shared-projects" ? ["shared_project_confirm", "shared_project_cancel"]
      : a.createdBy === "system:shared-ledger-join-offer" ? ["sl_join_accept", "sl_join_decline"] : null;
    if (!ids || a.source !== "system" || a.kind !== "authorize") return null;
    const rows = list(a.options, v => object(v));
    const buttons = rows.filter(r => r.type === "buttons").flatMap(r => list(r.buttons, v => object(v)));
    const accept = buttons.find(b => b.id === ids[0]), decline = buttons.find(b => b.id === ids[1]);
    if (buttons.length !== 2 || !accept || !decline) return null;
    const choice = projectChoice(a.extra, a.options);
    if (rows.some(r => r.type === "select") && !choice) return null;
    return { id: text(a.id, 128), project: text(a.project, 128), title: text(a.title, 256), context: text(a.context, 8192, true),
      expiresAt: Number(a.expiresAt), canAnswer: a.canAnswer === true, choice,
      accept: { id: ids[0]!, label: text(accept.label, 256) }, decline: { id: ids[1]!, label: text(decline.label, 256) } };
  }).filter((card): card is ProjectCard => card !== null);
}
