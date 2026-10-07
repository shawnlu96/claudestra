/** Synthetic screenshot entry; production navigation never imports this module. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SharedProjectsEntry } from "./projects-entry";
import { machines } from "@/lib/machines";
import { SharedProjectsPanel } from "./projects-panel";
import { ProjectChoice } from "./project-choice";
import { ProjectFailure, type CreateProject, type SharedProject, type ProjectSnapshot, type SharedProjectsPort } from "@/lib/shared-projects-model";
import { sharedProjectsApi } from "@/lib/shared-projects-api";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const owner = params.get("role") !== "member";
const scope = { centerId: "fixture-center", teamId: "fixture-team" };
let snapshot: ProjectSnapshot = {
  teams: [{ ...scope, name: "示例团队", personId: "fixture-owner", teamRole: owner ? "owner" : "member" }],
  projects: [], localProjects: [{ id: "local-app", name: "本机工作区", personal: false, bound: false }],
  peers: [{ id: "fixture-peer", name: "协作伙伴的机器" }],
};
const seed = (input: CreateProject): SharedProject => ({ ...scope, projectId: input.id ?? "sample", name: input.name,
  rev: 1, status: "active", role: owner ? "owner" : "member", availability: "ready",
  local: { id: "local-app", name: "本机工作区", dirs: [] } });
if (!owner || ["settings", "resilience"].includes(params.get("fixture") ?? "")) snapshot.projects.push(seed({ ...scope, name: "团队工作台", operationId: "fixture-operation" }));
let conflicted = params.get("fixture") === "settings";
let readFailure = 0;
let reads = 0;
let joined = false;
const calls: string[] = [];
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
    const p = snapshot.projects.find(p => p.projectId === ref.projectId)!;
    if (!conflicted) { conflicted = true; p.rev++; p.name = "同事更新的名称"; throw new ProjectFailure(409, structuredClone(p)); }
    if (patch.rev !== p.rev) throw new ProjectFailure(409, structuredClone(p));
    Object.assign(p, patch, { rev: p.rev + 1 });
  },
  members: async () => [{ personId: "fixture-owner", code: "项目创建人", role: "owner", status: "active" },
    { personId: "fixture-active-person", code: "已入组伙伴", role: "member", status: "active" },
    { personId: "fixture-existing-person", code: "fixture-existing-code", role: "member", status: "invited" },
    ...(joined ? [{ personId: "fixture-person", code: "协作伙伴", role: "member" as const, status: "invited" as const }] : [])],
  invite: async (_, input) => {
    if (Object.keys(input.recipient).length !== 1) throw new Error("synthetic-recipient-shape-mismatch");
    document.body.dataset.lastInvite = JSON.stringify(input);
    record("invite"); joined = true;
  },
  remove: async () => { record("remove"); joined = false; },
  directories: async (_, dirs) => { record("directories"); snapshot.projects[0]!.local!.dirs = dirs; },
  leave: async () => { record("leave"); snapshot = { ...snapshot, projects: [] }; },
};

function ChoiceFixture() {
  const [cardId, setCardId] = useState(0);
  const [recommended, setRecommended] = useState(params.get("recommended") === "none" ? "" : "create");
  const [busy, setBusy] = useState(false);
  return <main className="mx-auto max-w-md p-4">
    <h1 className="mb-4 text-xl font-semibold">本机对应选择（合成卡）</h1>
    <ProjectChoice cardId={`fixture-card-${cardId}`} choice={{ selectId: "fixture-binding", recommended, options: [
      { value: "create", label: "新建本机项目" }, { value: "local-app", label: "绑定本机工作区" },
    ] }} accept={{ id: "fixture-accept", label: "确认加入" }} decline={{ id: "fixture-decline", label: "不加入" }} busy={busy}
      onAnswer={choices => { document.body.dataset.answers = JSON.stringify(choices); setBusy(true); }} />
    <button type="button" className="btn btn-sm mt-4" onClick={() => setRecommended("local-app")}>替换合成卡</button>
    <button type="button" className="btn btn-sm mt-4" onClick={() => setCardId(id => id + 1)}>相同选项的新卡</button>
  </main>;
}

const render = () => createRoot(document.getElementById("root")!).render(
  params.get("fixture")?.startsWith("bindings") ? <SharedProjectsEntry /> : params.get("fixture") === "choice" ? <ChoiceFixture /> :
  <main className="mx-auto max-w-md p-4">
    <h1 className="mb-4 text-xl font-semibold">团队工作台</h1>
    {params.get("fixture") === "resilience" && <>
      <button onClick={() => { readFailure = 429; window.dispatchEvent(new Event("focus")); }}>合成临时失败</button>
      <button onClick={() => { readFailure = 403; window.dispatchEvent(new Event("focus")); }}>合成权限撤销</button>
    </>}
    {params.get("fixture") === "settings" && <button onClick={() => {
      Object.assign(snapshot.projects[0]!, { name: "外部更新名称", rev: 10 }); window.dispatchEvent(new Event("focus"));
    }}>合成外部更新</button>}
    <SharedProjectsPanel port={params.get("fixture") === "n4-source" ? sharedProjectsApi({ fp: "synthetic-machine" }, "demo-b") : port}
      openFeatures={p => { document.body.dataset.opened = p.projectId; }} />
  </main>,
);

if (params.get("fixture")?.startsWith("bindings")) {
  void machines.add({ fp: "synthetic-machine", name: "合成机器" }).then(() => machines.setCurrent("synthetic-machine")).then(render);
} else render();
