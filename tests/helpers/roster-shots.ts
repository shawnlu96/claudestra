import { serve, bundleHarness } from "./collab-fixture-serve";
import type { HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import type { TeamFromHome } from "../web-team-parity-browser-center.test";
import { rosterFixture, rosterSnapshotFixture } from "@/features/collab/team/roster-fixture";

/** Cold-start conditions: per-route delays (ms) and the first N reads of a route answering 500. */
export interface RosterServeOpts {
  delay?: Partial<Record<"config" | "contacts" | "context" | "roster" | "snapshot", number>>;
  fail?: Partial<Record<"roster" | "snapshot", number>>;
  /** Center project id in the binding context; differs from the local project id to catch reads on the wrong one. */
  centerProject?: string;
}
const ROUTES = { "/app-config.json": "config", "/api/v1/peers/contacts": "contacts", "/api/v1/shared-ledger/context": "context",
  "/api/v1/team/roster": "roster", "/api/v1/shared-projects/snapshot": "snapshot" } as const;

/** The binding port first reads context; the fixture must supply that authorization hint before its snapshot. */
export function serveRoster(home: HomeFixture, team: TeamFromHome, bundle: string, status = 200, opts: RosterServeOpts = {}) {
  const base = serve(home, team, bundle);
  const seen = { roster: 0, snapshot: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(req) {
    const url = new URL(req.url), path = url.pathname, route = ROUTES[path as keyof typeof ROUTES];
    if (route && opts.delay?.[route]) await Bun.sleep(opts.delay[route]!);
    if ((route === "roster" || route === "snapshot") && ++seen[route] <= (opts.fail?.[route] ?? 0)) return Response.json({ error: "synthetic" }, { status: 500 });
    if (route === "roster") return Response.json(rosterFixture(home.now, home.project), { status });
    if (route === "context") return Response.json({ identities: [{ center: "center", team: home.team,
      person: "person-a", project: opts.centerProject ?? home.project, localProjectId: home.project, homeInstanceId: home.sourceInstanceId }] });
    if (route === "snapshot") return Response.json(rosterSnapshotFixture(home.project, home.team, home.sourceInstanceId));
    url.host = new URL(base.server.url).host;
    return fetch(new Request(url.toString(), req));
  } });
  return { server, unexpected: base.unexpected, stop: () => { server.stop(true); base.server.stop(true); } };
}
export async function rosterBundle(out: string, baseline?: string) {
  if (!baseline) return bundleHarness(out);
  const helper = new URL("./collab-fixture-serve.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `import { bundleHarness } from ${JSON.stringify(helper)};
    console.log(await bundleHarness(${JSON.stringify(out)}));`], { cwd: baseline, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

/**
 * Minimal shell mounts the real roster hook twice; no React module is imported into the Bun test process.
 * The machine is recorded after the app config loads; the shell probes full scope only after its first frame
 * (the sidebar mounts later in the app), so the hook's first frame reads it passively.
 * view=roster mounts the real TeamRoster instead of the two bare readers.
 */
export async function dualRosterBundle(out: string) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  mkdirSync(out, { recursive: true });
  const entry = resolve(out, "dual-roster.tsx"), bundle = resolve(out, "dual-bundle");
  const path = (p: string) => JSON.stringify(resolve("web", p));
  writeFileSync(entry, `import React from ${path("node_modules/react")};
    import { createRoot } from ${path("node_modules/react-dom/client")};
    import { useTeamRoster } from ${path("features/collab/team/use-team-roster.ts")};
    import { TeamRoster } from ${path("features/collab/team/team-roster.tsx")};
    import { useFullScope } from ${path("features/chat/contacts-data.ts")};
    import { machines } from ${path("lib/machines.ts")};
    import { loadAppConfig } from ${path("lib/app-config.ts")};
    const q = new URLSearchParams(location.search), project = q.get("project");
    // Like MachineGate in direct mode: the machine is recorded after the app config arrives (delayable), then the app mounts.
    // late=1 mounts first, so the hook meets the machine, permission and binding all arriving after its first frame.
    const recorded = loadAppConfig().then(() => machines.load()).then(() => machines.add({ fp: "local", name: "fixture" })).then(() => machines.setCurrent("local"));
    function Reader() { const data = useTeamRoster(project); return React.createElement("output", null, data.roster ? "known" : "unknown"); }
    function Probe() { useFullScope(); return null; }
    function Shell() {
      const [probe, setProbe] = React.useState(false);
      React.useEffect(() => setProbe(true), []);
      const body = q.get("view") === "roster" ? React.createElement(TeamRoster, { project, ov: null, agents: [], now: Date.now() })
        : React.createElement(React.Fragment, null, React.createElement(Reader), React.createElement(Reader));
      return React.createElement(React.Fragment, null, probe && React.createElement(Probe), body);
    }
    const mount = () => createRoot(document.getElementById("root")).render(React.createElement(Shell));
    if (q.get("late") === "1") mount(); else void recorded.then(mount);`);
  const child = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", bundle,
    "--tsconfig-override", resolve("web/tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return bundle;
}
