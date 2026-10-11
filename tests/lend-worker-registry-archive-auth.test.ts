import { expect, test } from "bun:test";
import { bindHash } from "../src/lib/ask-bind.js";
import type { Ask } from "../src/lib/ledger-asks.js";
import { checkWorkerArchiveApproval, workerArchiveBind } from "../src/lib/lend-worker-registry-archive-auth.js";

const params = { listHash: "exact-list", registryHash: "whole-registry", backupTarget: "/private/backups" };
const actor = "agent-local";
function approval(): Ask {
  return { id: "ask-local", kind: "authorize", fromAgent: actor, state: "answered", expiresAt: 2000,
    bind: { ...workerArchiveBind(params), approve: ["approve"], paramsHash: bindHash(workerArchiveBind(params), actor) },
    answer: { owner: true, choices: ["[button:approve]"], labels: ["批准"], text: "", principal: "owner", via: "web_card", at: 1000 },
  } as Ask;
}

test("owner's exact action/list/registry/backup binding is required even for owner or master callers", () => {
  expect(() => checkWorkerArchiveApproval(approval(), actor, params, 1001)).not.toThrow();
  for (const change of [{ listHash: "other-list" }, { registryHash: "changed-registry" }, { backupTarget: "/other/backup" }]) {
    expect(() => checkWorkerArchiveApproval(approval(), actor, { ...params, ...change }, 1001)).toThrow("ask-check");
  }
  for (const caller of ["owner", "master", "agent-peer"]) {
    expect(() => checkWorkerArchiveApproval(approval(), caller, params, 1001)).toThrow("ask-check");
    expect(() => checkWorkerArchiveApproval(null, caller, params, 1001)).toThrow("B owner");
  }
});

test("PM/peer answers, stale, declined, substituted and wrong-action asks fail closed", () => {
  const good = approval();
  for (const answer of [{ ...good.answer!, owner: undefined }, { ...good.answer!, external: true }]) {
    expect(() => checkWorkerArchiveApproval({ ...good, answer }, actor, params, 1001)).toThrow("B owner");
  }
  for (const patch of [{ state: "superseded" }, { state: "open" }, { expiresAt: 1000 },
    { answer: { ...good.answer, choices: ["[button:cancel]"] } },
    { bind: { ...good.bind!, action: "other", paramsHash: bindHash({ action: "other", params }, actor) } }]) {
    expect(() => checkWorkerArchiveApproval({ ...good, ...patch } as Ask, actor, params, 1001)).toThrow("ask-check");
  }
});
