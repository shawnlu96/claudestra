/** Synthetic screenshot entry; production navigation never imports this module. */
import React from "react";
import { createRoot } from "react-dom/client";
import { SharedProjectsPanel } from "./projects-panel";
import { ProjectFailure, type CreateProject, type SharedProject, type ProjectSnapshot, type SharedProjectsPort } from "@/lib/shared-projects-model";

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
if (!owner) snapshot.projects.push(seed({ ...scope, name: "团队工作台", operationId: "fixture-operation" }));
let conflicted = false;
let joined = false;
const calls: string[] = [];
const record = (name: string) => { calls.push(name); document.body.dataset.calls = JSON.stringify(calls); };
const port: SharedProjectsPort = {
  list: async () => structuredClone(snapshot),
  create: async input => { record("create"); snapshot.projects.push(seed(input)); },
  complete: async () => { record("complete"); },
  patch: async (ref, patch) => {
    record("patch");
    const p = snapshot.projects.find(p => p.projectId === ref.projectId)!;
    if (!conflicted) { conflicted = true; p.rev++; p.name = "同事更新的名称"; throw new ProjectFailure(409, structuredClone(p)); }
    if (patch.rev !== p.rev) throw new ProjectFailure(409, structuredClone(p));
    Object.assign(p, patch, { rev: p.rev + 1 });
  },
  members: async () => [{ personId: "fixture-owner", code: "项目创建人", role: "owner", status: "active" },
    ...(joined ? [{ personId: "fixture-person", code: "协作伙伴", role: "member" as const, status: "invited" as const }] : [])],
  invite: async () => { record("invite"); joined = true; },
  remove: async () => { record("remove"); joined = false; },
  directories: async (_, dirs) => { record("directories"); snapshot.projects[0]!.local!.dirs = dirs; },
  leave: async () => { record("leave"); snapshot = { ...snapshot, projects: [] }; },
};

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-md p-4">
    <h1 className="mb-4 text-xl font-semibold">团队工作台</h1>
    <SharedProjectsPanel port={port} openFeatures={p => { document.body.dataset.opened = p.projectId; }} />
  </main>,
);
