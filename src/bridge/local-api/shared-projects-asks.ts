import type { Database } from "bun:sqlite";
import { bindHash, checkAsk } from "../../lib/ask-bind.js";
import { getAsk, patchAsk, ownerAnswered, type Ask } from "../../lib/ledger-asks.js";
import { askDb, askReadDb, createAsk } from "../asks.js";

/** N4 owns card storage and claiming; adapters must not substitute request-supplied card records. */
export function sharedProjectAskPorts(database?: Database) {
  return {
    openAsk: createAsk,
    getAsk: (id: string) => { const db = database ?? askReadDb(); return db ? getAsk(db, id) : null; },
    claimAsk: (approved: Ask): boolean => {
      const db = database ?? askDb();
      return db.transaction(() => {
        const current = getAsk(db, approved.id);
        if (!current || current.createdBy !== "system:shared-projects" || approved.createdBy !== "system:shared-projects"
          || current.state !== "answered" || current.extra.sharedProjectExecuted || !current.bind || !approved.bind
          || current.bind.paramsHash !== approved.bind.paramsHash
          || !ownerAnswered(current.answer)
          || !checkAsk({ ...current, fromAgent: current.createdBy }, current.bind.paramsHash, current.createdBy).ok
          || bindHash(current.bind, current.createdBy) !== bindHash(approved.bind, approved.createdBy)) return false;
        patchAsk(db, current.id, { extra: { sharedProjectExecuted: true } });
        return true;
      }).immediate();
    },
  };
}
