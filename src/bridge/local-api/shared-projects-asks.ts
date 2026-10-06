import { bindHash } from "../../lib/ask-bind.js";
import { getAsk, patchAsk, type Ask } from "../../lib/ledger-asks.js";
import { askDb, askReadDb, createAsk } from "../asks.js";

/** N4 owns card storage and claiming; adapters must not substitute request-supplied card records. */
export function sharedProjectAskPorts() {
  return {
    openAsk: createAsk,
    getAsk: (id: string) => { const db = askReadDb(); return db ? getAsk(db, id) : null; },
    claimAsk: (approved: Ask): boolean => {
      const db = askDb();
      return db.transaction(() => {
        const current = getAsk(db, approved.id);
        if (!current || current.createdBy !== "system:shared-projects" || approved.createdBy !== "system:shared-projects"
          || current.state !== "answered" || current.extra.sharedProjectExecuted || !current.bind || !approved.bind
          || current.bind.paramsHash !== approved.bind.paramsHash
          || bindHash(current.bind, current.createdBy) !== bindHash(approved.bind, approved.createdBy)) return false;
        patchAsk(db, current.id, { extra: { sharedProjectExecuted: true } });
        return true;
      })();
    },
  };
}
