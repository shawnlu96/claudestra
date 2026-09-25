import { describe, expect, test } from "bun:test";
import { detectOpeners, openArgv, type Probe } from "../web/lib/host/openers";
import { clientIpFromXff, isLocalClient, normalizeIp } from "../web/lib/host/local-client";

const macProbe = (apps: string[], cmds: string[] = []): Probe => ({
  exists: (p) => apps.some((a) => p.endsWith(`/${a}`)),
  which: (c) => cmds.includes(c),
});

describe("detectOpeners", () => {
  test("darwin: Finder always, apps by presence, table order kept", () => {
    const got = detectOpeners("darwin", macProbe(["iTerm.app", "Cursor.app", "Visual Studio Code.app"]));
    expect(got.map((o) => o.id)).toEqual(["finder", "iterm", "vscode", "cursor"]);
    expect(got[1]).toEqual({ id: "iterm", label: "iTerm2", kind: "terminal" });
  });
  test("linux: everything via PATH, no Finder", () => {
    const got = detectOpeners("linux", { exists: () => false, which: (c) => ["xdg-open", "kitty", "code"].includes(c) });
    expect(got.map((o) => o.id)).toEqual(["xdg", "kitty", "vscode"]);
  });
  test("win32: explorer always", () => {
    expect(detectOpeners("win32", { exists: () => false, which: () => false }).map((o) => o.id)).toEqual(["explorer"]);
  });
});

describe("openArgv", () => {
  const probe = macProbe(["iTerm.app", "kitty.app", "Visual Studio Code.app"], ["kitty", "code"]);
  test("darwin uses open / open -a, custom-arg terminals go through --args", () => {
    expect(openArgv("finder", "/x y", "darwin", probe)).toEqual(["open", "/x y"]);
    expect(openArgv("iterm", "/x", "darwin", probe)).toEqual(["open", "-a", "iTerm", "/x"]);
    expect(openArgv("vscode", "/x", "darwin", probe)).toEqual(["open", "-a", "Visual Studio Code", "/x"]);
    expect(openArgv("kitty", "/x", "darwin", probe)).toEqual(["open", "-a", "kitty", "--args", "--directory", "/x"]);
  });
  test("linux uses the command with its arg template", () => {
    const lp: Probe = { exists: () => false, which: (c) => ["gnome-terminal", "code"].includes(c) };
    expect(openArgv("gnome-terminal", "/x", "linux", lp)).toEqual(["gnome-terminal", "--working-directory=/x"]);
    expect(openArgv("vscode", "/x", "linux", lp)).toEqual(["code", "/x"]);
  });
  test("unknown or unavailable ids are refused", () => {
    expect(openArgv("rm", "/x", "darwin", probe)).toBeNull();
    expect(openArgv("warp", "/x", "darwin", probe)).toBeNull();
    expect(openArgv("finder", "/x", "linux", probe)).toBeNull();
  });
});

describe("local client detection", () => {
  test("parses the first hop and strips mapped prefix / ports", () => {
    expect(clientIpFromXff("::ffff:192.168.1.5, 10.0.0.1")).toBe("192.168.1.5");
    expect(clientIpFromXff("[::1]:5000")).toBe("::1");
    expect(clientIpFromXff("1.2.3.4:80")).toBe("1.2.3.4");
    expect(clientIpFromXff("")).toBeNull();
    expect(normalizeIp("FE80::1")).toBe("fe80::1");
  });
  test("loopback and any own interface address count as local", () => {
    const mine = ["127.0.0.1", "::1", "192.168.1.5", "100.113.223.87", "fe80::1"];
    expect(isLocalClient("::ffff:127.0.0.1", mine)).toBe(true);
    expect(isLocalClient("100.113.223.87", mine)).toBe(true);
    expect(isLocalClient("192.168.1.9", mine)).toBe(false);
    expect(isLocalClient("100.90.1.2", mine)).toBe(false);
    expect(isLocalClient(null, mine)).toBe(false);
  });
});
