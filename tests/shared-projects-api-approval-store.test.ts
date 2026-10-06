import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openLedger } from "../src/lib/ledger-store.js";
import { answerAsk, getAsk, openAsk } from "../src/lib/ledger-asks.js";
import { bindHash } from "../src/lib/ask-bind.js";
import { sharedProjectAskPorts } from "../src/bridge/local-api/shared-projects-asks.js";

test("N4 approval claim is durable across independent database connections and rejects forged bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "n4-asks-")), path = join(root, "ledger.sqlite"), db = openLedger(path);
  let second: Database | undefined;
  try {
    const createdBy = "system:shared-projects";
    const bind = { action: "shared_project_action", params: { operationId: "synthetic", selection: { mode: "create" } }, approve: ["confirm"] };
    const a = openAsk(db, { project: "master", source: "system", createdBy, kind: "authorize", title: "合成批准",
      options: [{ type: "buttons", buttons: [{ id: "confirm", label: "确认" }] }], allowText: false, blocking: true,
      bind: { ...bind, paramsHash: bindHash(bind, createdBy) }, extra: { sharedProjectAction: true } });
    const ports = sharedProjectAskPorts(db);
    expect(ports.claimAsk(a)).toBe(false);
    const approved = answerAsk(db, a.id, { principal: "owner:self", owner: true, via: "web_card", at: Date.now(),
      choices: ["[button:confirm]"], labels: ["确认"], text: "", final: true });
    const forged = structuredClone(approved);
    forged.bind!.params = { operationId: "other" };
    forged.bind!.paramsHash = bindHash(forged.bind!, createdBy);
    expect(ports.claimAsk(forged)).toBe(false);
    expect(ports.claimAsk(approved)).toBe(true);
    second = new Database(path);
    expect(sharedProjectAskPorts(second).claimAsk(approved)).toBe(false);
    expect(getAsk(second, a.id)!.extra.sharedProjectExecuted).toBe(true);
  } finally {
    second?.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});
