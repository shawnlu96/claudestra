import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import {
  base64urlToBytes, bytesToBase64url, codeFromFragment, defaultDeviceName, formatCode, hmacProof, isLoopbackHost, loadPendingPairing, parsePairFragment, savePendingPairing,
} from "@/lib/pairing";

describe("parsePairFragment（二维码 / 链接的 # 片段）", () => {
  test("#<fp>.<secret> → 两段；fp 转小写", () => {
    const secret = randomBytes(16).toString("base64url");
    expect(parsePairFragment(`#AB12-cd34-ef56-7890.${secret}`)).toEqual({ fp: "ab12-cd34-ef56-7890", secret });
  });
  test("老短码 / 空 / 形状不对 → null；codeFromFragment 只认 8 位短码", () => {
    expect(parsePairFragment("#ABCD2345")).toBeNull();
    expect(parsePairFragment("")).toBeNull();
    expect(parsePairFragment("#zz12-cd34-ef56-7890.abcdefghijklmnop")).toBeNull();
    expect(parsePairFragment("#ab12-cd34-ef56-7890.short")).toBeNull();
    expect(codeFromFragment("#abcd-2345")).toBe("ABCD2345");
    expect(codeFromFragment("#ab12-cd34-ef56-7890.abcdefghijklmnop")).toBe("");
    expect(codeFromFragment("#abc")).toBe("");
  });
});

describe("hmacProof（与 bridge src/lib/pairing-codes.ts 同一算法）", () => {
  test("WebCrypto 结果 == node createHmac(sha256, base64url 解出的秘密).digest(base64url)", async () => {
    const secret = randomBytes(16).toString("base64url");
    const challenge = randomBytes(32).toString("base64url");
    const expected = createHmac("sha256", Buffer.from(secret, "base64url")).update(challenge).digest("base64url");
    expect(await hmacProof(secret, challenge)).toBe(expected);
  });
  test("base64url 往返（无填充）", () => {
    const bytes = randomBytes(33);
    const s = bytesToBase64url(bytes);
    expect(s).not.toContain("=");
    expect(Buffer.from(base64urlToBytes(s))).toEqual(bytes);
  });
});

describe("短码整形 / 设备名 / 回环判定", () => {
  test("formatCode：大写、剔除非字母表字符、8 位、中间一杠", () => {
    expect(formatCode("abcd2345xyz")).toBe("ABCD-2345");
    expect(formatCode("ab-c")).toBe("ABC");
    expect(formatCode("i1o0")).toBe(""); // I / 1 / O / 0 不在字母表里
  });
  test("defaultDeviceName 从 UA 认设备与浏览器", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    const macChrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(defaultDeviceName(iphone)).toBe("iPhone · Safari");
    expect(defaultDeviceName(macChrome)).toBe("Mac · Chrome");
    expect(defaultDeviceName(ipad)).toBe("iPad · Safari");
    expect(defaultDeviceName("weird", "Plan9")).toBe("Plan9");
  });
  test("isLoopbackHost", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("mini.tail1234.ts.net")).toBe(false);
  });
});

describe("等批准的请求跨页面留存（离开配对页再回来接着等）", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  test("存了就读得回；过期、坏数据、清掉都按没有", () => {
    const store = memory();
    const p = { fp: "local", approvalId: "a1", machineName: "mac", code: "ABCD2345", approver: false, expiresAt: "2026-10-03T15:48:00.000Z" };
    savePendingPairing(p, store);
    expect(loadPendingPairing(Date.parse("2026-10-03T15:40:00Z"), store)).toEqual(p);
    expect(loadPendingPairing(Date.parse("2026-10-03T15:48:00Z"), store)).toBeNull();
    store.setItem("cstra_pair_pending", "{not json");
    expect(loadPendingPairing(0, store)).toBeNull();
    savePendingPairing(p, store);
    savePendingPairing(null, store);
    expect(loadPendingPairing(0, store)).toBeNull();
  });

  test("禁用站点存储（读 sessionStorage 属性就抛 SecurityError）：默认参数取存储也不抛，按没有记录处理", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    try {
      const p = { fp: "local", approvalId: "a1", machineName: "mac", expiresAt: "2099-01-01T00:00:00.000Z" };
      expect(() => savePendingPairing(p)).not.toThrow();
      expect(() => savePendingPairing(null)).not.toThrow();
      expect(loadPendingPairing()).toBeNull();
    } finally {
      if (before) Object.defineProperty(globalThis, "sessionStorage", before);
      else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});
