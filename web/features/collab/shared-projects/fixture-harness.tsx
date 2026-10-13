/** Synthetic screenshot entry; production navigation never imports this module. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SharedProjectsEntry } from "./projects-entry";
import { machines } from "@/lib/machines";
import { SharedProjectsPanel } from "./projects-panel";
import { ProjectChoice } from "./project-choice";
import { ProjectCards } from "./project-cards";
import { ProjectFailure, type CreateProject, type ProjectCard, type SharedProject, type ProjectSnapshot, type SharedProjectsPort } from "@/lib/shared-projects-model";
import { sharedProjectsApi } from "@/lib/shared-projects-api";
import { setLang } from "@/lib/i18n";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const owner = params.get("role") !== "member";
// ?lang=en: English UI, and the synthetic data names switch to English too so the English screenshots carry no Chinese data.
const en = params.get("lang") === "en";
if (en) setLang("en");
const L = (zh: string, english: string) => en ? english : zh;
const scope = { centerId: "fixture-center", teamId: "fixture-team" };
const team = { named: { name: L("示例团队", "Sample team"), rev: 1 }, unnamed: { name: null, rev: 1 }, unavailable: null }[params.get("team") ?? "named"] ?? null;
const directory = params.get("directory") === "1" ? [{ personId: "fixture-owner", code: L("项目创建人", "Project creator"), teamRole: "owner" as const },
  { personId: "fixture-active-person", code: L("已入组伙伴", "Joined partner"), teamRole: "member" as const },
  { personId: "fixture-directory-person", code: L("目录中的伙伴", "Directory partner"), teamRole: "member" as const }] : null;
let snapshot: ProjectSnapshot = {
  teams: [{ ...scope, personId: "fixture-owner", teamRole: owner ? "owner" : "member", team, directory },
    ...params.get("centers") === "2" ? [{ centerId: "fixture-second-center-b7c41e", teamId: "fixture-team", personId: "fixture-owner",
      teamRole: "owner" as const, team: { name: L("另一中心团队", "Other center team"), rev: 1 }, directory: null }] : []],
  projects: [], localProjects: [{ id: "local-app", name: L("本机工作区", "Local workspace"), personal: false, bound: false }],
  peers: [{ id: "fixture-peer", name: L("协作伙伴的机器", "Partner machine") }],
};
const seed = (input: CreateProject): SharedProject => ({ ...scope, projectId: input.id ?? "sample", name: input.name,
  rev: 1, status: "active", role: owner ? "owner" : "member", availability: "ready",
  local: { id: "local-app", name: L("本机工作区", "Local workspace"), dirs: [] } });
if (!owner || ["settings", "resilience", "conflict-refresh"].includes(params.get("fixture") ?? "")) {
  snapshot.projects.push(seed({ ...scope, name: L("团队工作台", "Team workbench"), operationId: "fixture-operation" }));
}
let conflicted = params.get("fixture") === "settings";
let readFailure = 0;
let reads = 0;
let joined = false;
const calls: string[] = [];
const patchRevisions: number[] = [];
const rename = params.get("rename");
const renames: { rev: number; name: string }[] = [];
const record = (name: string) => { calls.push(name); document.body.dataset.calls = JSON.stringify(calls); };
let createdOperation: string | null = null;
const port: SharedProjectsPort = {
  list: async () => {
    document.body.dataset.reads = String(++reads);
    if (readFailure || params.get("fixture") === "no-binding") throw new ProjectFailure(readFailure || 403);
    return structuredClone(snapshot);
  },
  create: async input => {
    record("create"); createdOperation = input.operationId; snapshot.projects.push(seed(input));
    if (params.get("fixture") === "pending") throw new ProjectFailure(202);
    if (params.get("fixture") === "recovery") throw new Error("synthetic-sensitive-sentinel");
  },
  complete: async input => {
    record("complete");
    if (params.get("fixture") === "pending") throw new ProjectFailure(202);
    if (createdOperation !== input.operationId) throw new Error("synthetic-operation-mismatch");
  },
  patch: async (ref, patch) => {
    record("patch");
    patchRevisions.push(patch.rev); document.body.dataset.patchRevisions = JSON.stringify(patchRevisions);
    const p = snapshot.projects.find(p => p.projectId === ref.projectId)!;
    if (!conflicted) { conflicted = true; p.rev++; p.name = L("同事更新的名称", "Name a teammate updated"); throw new ProjectFailure(409, structuredClone(p)); }
    if (patch.rev !== p.rev) throw new ProjectFailure(409, structuredClone(p));
    Object.assign(p, patch, { rev: p.rev + 1 });
  },
  members: async () => [{ personId: "fixture-owner", code: L("项目创建人", "Project creator"), role: "owner", status: "active" },
    { personId: "fixture-active-person", code: L("已入组伙伴", "Joined partner"), role: "member", status: "active" },
    { personId: "fixture-existing-person", code: "fixture-existing-code", role: "member", status: "invited" },
    ...(joined ? [{ personId: "fixture-person", code: L("协作伙伴", "Partner"), role: "member" as const, status: "invited" as const }] : [])],
  invite: async (_, input) => {
    if (Object.keys(input.recipient).length !== 1) throw new Error("synthetic-recipient-shape-mismatch");
    document.body.dataset.lastInvite = JSON.stringify(input);
    record("invite"); joined = true;
  },
  remove: async () => { record("remove"); joined = false; },
  updateTeam: async (ref, patch) => {
    record("updateTeam"); renames.push(patch); document.body.dataset.renames = JSON.stringify(renames);
    const target = snapshot.teams.find(t => t.centerId === ref.centerId && t.teamId === ref.teamId)!;
    if (rename === "unconfirmed") throw new ProjectFailure(409, undefined, { code: "project_conflict", team: null });
    if (rename === "nocurrent") throw new ProjectFailure(409, undefined, { code: "team_conflict", team: null });
    if (rename === "conflict" && renames.length === 1) target.team = { name: L("同事改的团队名", "Team name a teammate changed"), rev: target.team!.rev + 1 };
    if (patch.rev !== target.team?.rev) throw new ProjectFailure(409, undefined, { code: "team_conflict", team: structuredClone(target.team) });
    return target.team = { name: patch.name, rev: patch.rev + 1 };
  },
  directories: async (_, dirs) => { record("directories"); snapshot.projects[0]!.local!.dirs = dirs; },
  leave: async () => { record("leave"); snapshot = { ...snapshot, projects: [] }; },
};

// Reuse the same response so expiration must advance even when a poll brings no changed card data.
const expiryCards: ProjectCard[] = [{ id: "expiry-card", project: "master", title: L("合成过期卡", "Synthetic expiring card"), context: L("仅用于过期按钮测试", "Only for the expiry button test"), canAnswer: true,
  expiresAt: Number(params.get("expiresAt")), choice: null,
  accept: { id: "expiry-accept", label: L("确认合成操作", "Confirm synthetic action") }, decline: { id: "expiry-decline", label: L("取消合成操作", "Cancel synthetic action") } }];
const expiryPort: SharedProjectsPort = { ...port,
  cards: async () => {
    document.body.dataset.cardReads = String(Number(document.body.dataset.cardReads ?? 0) + 1);
    return expiryCards;
  },
  answer: async () => { record("answer"); },
};

function ChoiceFixture() {
  const [cardId, setCardId] = useState(0);
  const [recommended, setRecommended] = useState(params.get("recommended") === "none" ? "" : "create");
  const [busy, setBusy] = useState(false);
  return <main className="mx-auto max-w-md p-4">
    <h1 className="mb-4 text-xl font-semibold">{L("本机对应选择（合成卡）", "Local binding choice (synthetic card)")}</h1>
    <ProjectChoice cardId={`fixture-card-${cardId}`} choice={{ selectId: "fixture-binding", recommended, options: [
      { value: "create", label: L("新建本机项目", "Create local project") }, { value: "local-app", label: L("绑定本机工作区", "Bind local workspace") },
    ] }} accept={{ id: "fixture-accept", label: L("确认加入", "Join") }} decline={{ id: "fixture-decline", label: L("不加入", "Do not join") }} busy={busy}
      onAnswer={choices => { document.body.dataset.answers = JSON.stringify(choices); setBusy(true); }} />
    <button type="button" className="btn btn-sm mt-4" onClick={() => setRecommended("local-app")}>替换合成卡</button>
    <button type="button" className="btn btn-sm mt-4" onClick={() => setCardId(id => id + 1)}>相同选项的新卡</button>
  </main>;
}

const render = () => createRoot(document.getElementById("root")!).render(
  params.get("fixture") === "expiry" ? <ProjectCards port={expiryPort} refresh={async () => {}} /> :
  params.get("fixture")?.startsWith("bindings") ? <SharedProjectsEntry /> : params.get("fixture") === "choice" ? <ChoiceFixture /> :
  <main className="mx-auto max-w-md p-4">
    <h1 className="mb-4 text-xl font-semibold">{L("团队工作台", "Team workbench")}</h1>
    {params.get("fixture") === "resilience" && <>
      <button onClick={() => { readFailure = 429; window.dispatchEvent(new Event("focus")); }}>合成临时失败</button>
      <button onClick={() => { readFailure = 403; window.dispatchEvent(new Event("focus")); }}>合成权限撤销</button>
    </>}
    {["settings", "conflict-refresh"].includes(params.get("fixture") ?? "") && <button onClick={() => {
      Object.assign(snapshot.projects[0]!, { name: L("外部更新名称", "Externally updated name"), rev: 10 }); window.dispatchEvent(new Event("focus"));
    }}>合成外部更新</button>}
    <SharedProjectsPanel port={params.get("fixture") === "n4-source" ? sharedProjectsApi({ fp: "synthetic-machine" }, "demo-b") : port}
      openFeatures={p => { document.body.dataset.opened = p.projectId; }} />
  </main>,
);

if (params.get("fixture")?.startsWith("bindings")) {
  void machines.add({ fp: "synthetic-machine", name: "合成机器" }).then(() => machines.setCurrent("synthetic-machine")).then(render);
} else render();
