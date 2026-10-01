import {
  authenticateSharedLedgerRequest, sharedLedgerCredentialHash, type SharedLedgerSignedRequest,
  type SharedLedgerPrincipal,
} from "../lib/shared-ledger-auth.js";
import { SharedLedgerError, type SharedLedgerCommand, type SharedLedgerImport, type SharedLedgerProjection } from "../lib/shared-ledger-contract.js";
import { Store, decode } from "./store.js";
import { loadCredential, recheck, hasRead } from "./identity.js";
import { Conflict, feature, detail, meta, ownReceipt } from "./reads.js";
import { executeCommand } from "./commands.js";
import { importManifest } from "./imports.js";
import { applyProjection } from "./projections.js";

/** All business writes share one synchronous transaction. Replay claims commit independently of rejected commands. */
export class LedgerService {
  constructor(readonly store: Store, readonly notify?: (serverSeq: number) => void) {}
  handle(req: SharedLedgerSignedRequest, now = Date.now()): { status: number; body: unknown } {
    try {
      const credential = loadCredential(this.store, req.bearer);
      const route = /^\/v1\/teams\/([A-Za-z0-9_.:-]+)\/(features|commands|imports|projections)(?:\/([A-Za-z0-9_.:-]+))?$/.exec(req.path);
      const target: { projectId?: string; homeInstanceId?: string } = {};
      // Metadata lookup is team-bound; no snapshot is materialized until authentication succeeds.
      if (route && credential && route[1] === credential.teamId) {
        if (req.method === "GET" && route[2] === "features" && route[3]) {
          const f = this.store.get<{ projectId: string }>("SELECT projectId FROM features WHERE teamId=? AND id=?", credential.teamId, route[3]);
          target.projectId = f?.projectId;
        } else if (req.method === "GET" && route[2] === "commands" && route[3]) {
          const row = this.store.get<{ projectId: string }>(`SELECT projectId FROM command_receipts
            WHERE teamId=? AND personId=? AND instanceId=? AND requestId=?`, credential.teamId, credential.personId, credential.instanceId, route[3]);
          target.projectId = row?.projectId;
        } else if (req.method === "POST" && route[2] === "projections") {
          // Raw ids can only locate home metadata; C1 still rejects unsigned/malformed bodies and extra fields.
          let raw: { payload?: { featureId?: string } };
          try { raw = JSON.parse(req.body); }
          catch { raw = {}; } // Invalid JSON is rejected by C1 after transport verification; it cannot select a target.
          if (typeof raw?.payload?.featureId === "string") {
            const f = this.store.get<{ projectId: string; homeInstanceId: string }>(`SELECT f.projectId,l.homeInstanceId FROM features f
              JOIN feature_locations l ON l.featureId=f.id WHERE f.teamId=? AND f.id=?`, credential.teamId, raw.payload.featureId);
            target.projectId = f?.projectId;
            target.homeInstanceId = f?.homeInstanceId;
          }
        }
      }
      const auth = authenticateSharedLedgerRequest(req, credential, this.store, now, target);
      const p = auth.principal;
      if (!route) throw new SharedLedgerError("forbidden");
      if (req.method === "GET") return { status: 200, body: this.store.read(() => {
        recheck(this.store, req.bearer, p, now, req.publicKey);
        return this.read(p, route[2]!, route[3]);
      }) };
      const before = this.store.seq();
      const body = this.store.write(() => {
        recheck(this.store, req.bearer, p, now, req.publicKey);
        if (route[2] === "commands") return executeCommand(this.store, p, auth.payload as SharedLedgerCommand, now);
        if (route[2] === "imports") return importManifest(this.store, p, auth.payload as SharedLedgerImport, now);
        return applyProjection(this.store, p, auth.payload as SharedLedgerProjection, now);
      });
      if (this.store.seq() > before && this.notify) {
        try { this.notify(this.store.seq()); }
        catch { console.error("Shared ledger notification failed after durable commit"); } // Notification loss cannot roll back a committed receipt.
      }
      return { status: 200, body };
    } catch (error) {
      if (error instanceof Conflict) return { status: 409, body: error.response };
      if (error instanceof SharedLedgerError) return { status: error.status, body: { code: error.code, status: error.status, message: error.message } };
      console.error("Shared ledger storage request failed", sharedLedgerCredentialHash(String((error as Error).name)));
      return { status: 500, body: { message: "Shared ledger unavailable" } };
    }
  }
  private read(p: SharedLedgerPrincipal, resource: string, item?: string): unknown {
    if (resource === "commands" && item) {
      const receipt = ownReceipt(this.store, p, item);
      if (receipt && !hasRead(p, receipt.projectId)) throw new SharedLedgerError("forbidden");
      return receipt ? { status: "committed", receipt: decode(receipt.response) } : { status: "unknown", requestId: item };
    }
    if (item) {
      const f = feature(this.store, p.teamId, item);
      if (!f || !hasRead(p, f.projectId)) throw new SharedLedgerError("forbidden");
      return detail(this.store, p.teamId, item);
    }
    const features = this.store.all<{ data: string }>("SELECT data FROM features WHERE teamId=? ORDER BY id", p.teamId)
      .map((r) => decode<ReturnType<typeof detail>["feature"]>(r.data)).filter((f) => hasRead(p, f.projectId));
    return { ...meta(this.store, p.teamId), features };
  }
}
