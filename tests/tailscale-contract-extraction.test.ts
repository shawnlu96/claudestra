import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as hub from "../src/lib/tailscale.js";
import * as leaf from "../src/lib/tailscale-contract.js";

const HOST = "my-mac.tail0000.ts.net";
const EMPTY = { ports: [], handlers: [] };
const STATUS = {
  backendState: "Running", running: true, dnsName: HOST, hostName: "my-mac",
  ipv4: [], ipv6: [], magicDNS: true, httpsEnabled: true, certDomains: [HOST], authUrl: "", version: "",
};
const BASE: hub.PlanInput = { cliFound: true, status: STATUS, serve: EMPTY, webPort: 3333, port443Busy: false };
const MOVED = ["parseTailscaleStatus", "parseServeStatus", "proxyTargetsPort", "findServeForPort", "httpsUrl", "serveArgs", "planHttps"] as const;

test("public exports are the leaf functions, and the leaf has no runtime dependencies", () => {
  for (const key of MOVED) expect(hub[key]).toBe(leaf[key]);
  const source = readFileSync(new URL("../src/lib/tailscale-contract.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/\b(?:import|require)\s*(?:[({*]|["'])/);
  expect(source).not.toMatch(/\b(?:Bun|process|fetch)\b/);
});

// This same matrix also runs against a temporary copy of the pre-extraction public module.
for (const [name, api] of [["public", hub], ["leaf", leaf]] as const) {
  describe(`${name} matrix`, () => {
    test.each([undefined, null, false, 0, "", "{bad json", [], [1]].map((value) => [value]))("rejects non-object status/serve %j", (value) => {
      expect(api.parseTailscaleStatus(value)).toBeNull();
      expect(api.parseServeStatus(value)).toEqual(EMPTY);
    });

    test("empty and partially malformed status preserve key order and defaults", () => {
      const expected = { ...STATUS, backendState: "", running: false, dnsName: "", hostName: "", magicDNS: false,
        httpsEnabled: false, certDomains: [] };
      for (const value of [{}, { Self: [], CurrentTailnet: "x", TailscaleIPs: [1], CertDomains: [false], BackendState: 7 }]) {
        expect(JSON.stringify(api.parseTailscaleStatus(value))).toBe(JSON.stringify(expected));
      }
    });

    test("status unicode, escapes, unknown/duplicate keys, IP fallback and permissive strings", () => {
      const value = JSON.parse('{"BackendState":"Stopped","BackendState":"Running","Unknown":true}');
      Object.assign(value, {
        Self: { DNSName: "设备\\\".tail0000.ts.net..", HostName: "名\n称", TailscaleIPs: [false, "100.64.0.1", "::1", "x.y:z", "100.64.0.1"] },
        TailscaleIPs: [false], CurrentTailnet: { MagicDNSEnabled: 1 }, CertDomains: [null, HOST, HOST],
        AuthURL: "https://example.invalid/登录?q=\"\\", Version: "1\t2",
      });
      expect(api.parseTailscaleStatus(value)).toEqual({
        ...STATUS, dnsName: "设备\\\".tail0000.ts.net.", hostName: "名\n称", magicDNS: false,
        ipv4: ["100.64.0.1", "x.y:z", "100.64.0.1"], ipv6: ["::1", "x.y:z"],
        certDomains: [HOST, HOST], authUrl: value.AuthURL, version: "1\t2",
      });
      expect(api.parseTailscaleStatus({ ...value, TailscaleIPs: ["not-an-ip"] })!.ipv4).toEqual([]);
      expect(api.parseTailscaleStatus({ ...value, BackendState: "running" })!.running).toBe(false);
    });

    test("serve keeps numeric quirks, stable duplicates and handler order", () => {
      const value = {
        TCP: { "8443": {}, "443": null, "0443": true, "1e3": false, "65536": {}, "0": {}, "-1": {}, "1.5": {}, bad: {} },
        Web: { "设备:8443": { Handlers: { "/路\\径\n": { Proxy: "http://localhost:3333" }, "/": { Text: "x" }, "/bad": null } },
          "[::1]:000443": { Handlers: { "/": { Proxy: "3333" } } }, "bad": {}, "h:4": { Handlers: [] }, "h:5": null },
        Unknown: { anything: true },
      };
      expect(JSON.stringify(api.parseServeStatus(value))).toBe(JSON.stringify({ ports: [443, 443, 1000, 8443, 65536], handlers: [
        { host: "设备", port: 8443, path: "/路\\径\n", proxy: "http://localhost:3333" },
        { host: "设备", port: 8443, path: "/", proxy: "" },
        { host: "设备", port: 8443, path: "/bad", proxy: "" },
        { host: "[::1]", port: 443, path: "/", proxy: "3333" },
      ] }));
      expect(api.parseServeStatus(JSON.parse('{"TCP":{"443":{}},"TCP":{"8443":{}}}')).ports).toEqual([8443]);
      expect(api.parseServeStatus({ TCP: [], Web: "x" })).toEqual(EMPTY);
    });

    test("proxy spellings and first root handler preserve matching and reference identity", () => {
      for (const proxy of ["3333", " localhost:3333/ ", "http://127.0.0.1:3333", "https+insecure://[::1]:3333/"]) {
        expect(api.proxyTargetsPort(proxy, 3333)).toBe(true);
      }
      for (const proxy of ["", "https://elsewhere:3333", "http://localhost:3333/path", "http://localhost:3333?x", "3334"]) {
        expect(api.proxyTargetsPort(proxy, 3333)).toBe(false);
      }
      const first = { host: HOST, port: 8443, path: "/", proxy: "3333" };
      const serve = { ports: [], handlers: [{ ...first, path: "/app" }, first, { ...first, port: 443 }] };
      expect(api.findServeForPort(serve, 3333)).toBe(first);
      expect(api.findServeForPort(serve, 3334)).toBeNull();
    });

    test("all decision priorities and occupied-port combinations preserve output bytes", () => {
      const statuses = [null, { ...STATUS, running: false, backendState: "NeedsLogin", authUrl: "登录\n\\" },
        { ...STATUS, dnsName: "" }, { ...STATUS, httpsEnabled: false }, STATUS];
      const entry = { url: "https://example.invalid/入口?x=\"\\", source: "external" as const };
      const existing = { ports: [8443], handlers: [{ host: "ignored", port: 8443, path: "/", proxy: "3333" }] };
      const kinds = new Set<string>();
      for (const cliFound of [false, true]) for (const status of statuses) for (const workingEntry of [undefined, null, entry]) {
        for (const serve of [EMPTY, existing, { ports: [443, 8443], handlers: [] }]) {
          for (const port443Busy of [false, true]) for (const port8443Busy of [undefined, false, true]) {
            const input = { ...BASE, cliFound, status, workingEntry, serve, port443Busy, port8443Busy };
            const before = JSON.stringify(input);
            let expected: hub.HttpsPlan;
            if (!cliFound || status === null) expected = { kind: "not-installed" };
            else if (!status.running) expected = { kind: "need-login", backendState: status.backendState, authUrl: status.authUrl };
            else if (workingEntry) expected = { kind: "reuse", ...entry };
            else if (!status.dnsName) expected = { kind: "no-magicdns" };
            else if (serve === existing) expected = { kind: "reuse", url: `https://${HOST}:8443`, source: "serve" };
            else if (!status.httpsEnabled) expected = { kind: "need-https-enable", dnsName: HOST };
            else if (serve.ports.length || (port443Busy && port8443Busy)) {
              expected = { kind: "fallback-manual", reason: "443 与 8443 都已被占用" };
            } else {
              const port = port443Busy ? 8443 : 443;
              expected = { kind: "serve", port, url: `https://${HOST}${port === 443 ? "" : ":8443"}`,
                args: ["serve", "--bg", `--https=${port}`, "http://127.0.0.1:3333"] };
            }
            const actual = api.planHttps(input);
            kinds.add(actual.kind);
            expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
            expect(JSON.stringify(input)).toBe(before);
          }
        }
      }
      expect([...kinds].sort()).toEqual(["fallback-manual", "need-https-enable", "need-login", "no-magicdns", "not-installed", "reuse", "serve"]);
    });

    test("URL/argv text and exceptional property access remain unnormalized", () => {
      expect(api.httpsUrl("设备.\\\"", 443)).toBe('https://设备.\\"');
      expect(api.httpsUrl(HOST, 0)).toBe(`https://${HOST}:0`);
      expect(api.serveArgs(8443, 0)).toEqual(["serve", "--bg", "--https=8443", "http://127.0.0.1:0"]);
      const error = new Error("synthetic getter failure");
      const bad = { get Self(): never { throw error; } };
      expect(() => api.parseTailscaleStatus(bad)).toThrow(error);
      expect(() => api.parseServeStatus({ get TCP(): never { throw error; } })).toThrow(error);
      expect(() => api.planHttps({ ...BASE, get status(): never { throw error; } })).toThrow(error);
    });
  });
}

test("public async readers use parsed CLI output, including failure JSON; no real CLI runs", async () => {
  const output = JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://example.invalid/login", TCP: { "8443": {} } });
  let out = output;
  const calls: unknown[] = [];
  const spawn = spyOn(Bun, "spawn").mockImplementation(((args: unknown) => {
    calls.push(args);
    return { stdout: new Response(out).body, stderr: new Response("synthetic stderr").body, exited: Promise.resolve(1) };
  }) as typeof Bun.spawn);
  try {
    expect(await hub.readTailscaleStatus("/fixture/tailscale")).toEqual(leaf.parseTailscaleStatus(JSON.parse(output)));
    expect(await hub.readServeStatus("/fixture/tailscale")).toEqual(leaf.parseServeStatus(JSON.parse(output)));
    for (out of ["", "{bad json", "[]"]) {
      expect(await hub.readTailscaleStatus("/fixture/tailscale")).toBeNull();
      expect(await hub.readServeStatus("/fixture/tailscale")).toEqual(EMPTY);
    }
    const count = calls.length;
    expect(await hub.readTailscaleStatus(null)).toBeNull();
    expect(await hub.readServeStatus(null)).toEqual(EMPTY);
    expect(calls).toHaveLength(count);
    expect(calls.slice(0, 2)).toEqual([
      ["/fixture/tailscale", "status", "--json"], ["/fixture/tailscale", "serve", "status", "--json"],
    ]);
  } finally {
    spawn.mockRestore();
  }
});
