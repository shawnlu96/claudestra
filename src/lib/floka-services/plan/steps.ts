import { inventory, legacy, port, stopped, type Context } from "./safety.ts";
import type { Journal, Service, Side } from "./types.ts";

type Kind = "prepare" | "unload" | "exit" | "restore" | "load" | "commit";
interface Step { kind: Kind; side: Side; service?: Service }

export function steps(c: Context, direction: Journal["direction"]): Step[] {
  const group = (kind: Kind, side: Side): Step[] => c.plan.services.map((service) => ({ kind, side, service }));
  return direction === "forward"
    ? [...group("prepare", "new"), ...group("unload", "old"), ...group("exit", "old"),
      ...group("load", "new"), { kind: "commit", side: "new" }]
    : [...group("unload", "new"), ...group("exit", "new"), ...group("unload", "old"), ...group("exit", "old"),
      ...group("restore", "old"), ...group("load", "old"), { kind: "commit", side: "old" }];
}

async function load(c: Context, d: Service, side: Side): Promise<void> {
  const opposite = side === "new" ? "old" : "new";
  await legacy(c);
  await inventory(c, opposite);
  const state = await port(c, () => c.controller.inspect(c.plan, d, side));
  if (stopped(state)) await port(c, () => c.controller.load(c.plan, d, side));
  else if (!state.loaded) throw new Error(`Unregistered surviving process: ${side}:${d.name}`);
  // A crash after load but before checkpoint reuses the registered job, never boots a second copy.
  await inventory(c, opposite);
}

async function commit(c: Context, side: Side): Promise<void> {
  const opposite = side === "new" ? "old" : "new";
  await legacy(c);
  await inventory(c, opposite, side);
  for (const d of c.plan.services) {
    if (!await port(c, () => c.controller.health(c.plan, d, side))) throw new Error(`Health failed: ${side}:${d.name}`);
  }
  // Health results from before a crash are never reused to authorize a later commit.
  await inventory(c, opposite, side);
  await port(c, () => c.controller.commit(c.plan, side));
}

export async function execute(c: Context, step: Step): Promise<void> {
  const { controller: io, plan: p } = c;
  const { kind, side, service: d } = step;
  await legacy(c);
  await inventory(c);
  if (kind === "commit") return commit(c, side);
  if (!d) throw new Error("Missing daemon in step");
  switch (kind) {
    case "prepare":
      await inventory(c, "new");
      return port(c, () => io.prepare(p, d));
    case "unload":
      return port(c, () => io.unload(p, d, side));
    case "exit": {
      if (!await port(c, () => io.waitExited(p, d, side))) throw new Error(`PID exit unconfirmed: ${side}:${d.name}`);
      const state = await port(c, () => io.inspect(p, d, side));
      if (!stopped(state)) throw new Error(`Exit not confirmed: ${side}:${d.name}`);
      return;
    }
    case "restore":
      await inventory(c, "new");
      await inventory(c, "old");
      return port(c, () => io.restoreOld(p, d));
    case "load": return load(c, d, side);
  }
}
