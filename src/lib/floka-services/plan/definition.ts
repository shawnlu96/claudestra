import { renderDaemonPlist, type DaemonPlistInput } from "../../daemon-plist.ts";
import type { ServicePlan } from "./types.ts";

// Importing cli-wrapper at runtime would initialize machine paths. Keep this pure and reuse its renderer.
const NAMES = ["bridge", "cron", "scheduler", "launcher"] as const;
const LEGACY = ["com.claudestra.autostart", "com.claudestra.web"] as const;

export function createServicePlan(id: string, input: Omit<DaemonPlistInput, "daemon">): ServicePlan {
  return {
    id,
    legacyLabels: [...LEGACY],
    services: NAMES.map((name) => ({
      name, oldLabel: `com.claudestra.${name}`, newLabel: `ai.floka.${name}`,
      plist: renderDaemonPlist({ ...input, daemon: { label: `ai.floka.${name}`, script: `src/${name}.ts`, stem: name } }),
    })),
  };
}

/** Reject incomplete/mutated plans before touching the controller, including replay with different labels. */
export function validatePlan(p: ServicePlan): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(p.id)) throw new Error("Invalid service transaction id");
  if (JSON.stringify(p.legacyLabels) !== JSON.stringify(LEGACY) || p.services.length !== NAMES.length) {
    throw new Error("Plan must cover four daemons and legacy autostart/web");
  }
  for (const [i, d] of p.services.entries()) {
    if (d.name !== NAMES[i] || d.oldLabel !== `com.claudestra.${d.name}` || d.newLabel !== `ai.floka.${d.name}` || !d.plist.trim()) {
      throw new Error("Invalid service identity or missing staged plist");
    }
  }
}
