import type { Ask } from "../../lib/ledger-asks.js";
import type { SharedProjectsPorts } from "./shared-projects-ports.js";
import { answerSharedProject } from "./shared-projects-actions.js";

let ports: SharedProjectsPorts | undefined;
/** N4 production adapter registration; absence must remain a visible 503 rather than fabricated project success. */
export function configureSharedProjects(adapter: SharedProjectsPorts | undefined): void { ports = adapter; }
export function sharedProjectsPorts(): SharedProjectsPorts | undefined { return ports; }
export async function onSharedProjectAnswered(ask: Ask): Promise<void> {
  if (!ports || ask.extra.sharedProjectAction !== true) return;
  try { await answerSharedProject(ask, ports); }
  catch { console.warn("shared project authorization or completion rejected"); } // Fixed wording: an executor error can contain credentials.
}
