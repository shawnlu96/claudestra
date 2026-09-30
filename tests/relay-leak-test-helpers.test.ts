/** relay-leak-test-helpers 的 leakedIn：原文和每种可逆编码都要能抓到，随机字节不许误报，短 needle 直接拒 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { leakedIn, mark } from "./relay-leak-test-helpers.ts";

const needle = `机密内容-${mark("body")}`;
const wrap = (s: string) => Buffer.from(`{"x":"${s}","y":1}`, "utf8");

describe("leakedIn", () => {
  test("base64 / base64url 藏在更大的串里：前面多几个字节（三种对齐）、带不带填充都抓得到", () => {
    for (let pre = 0; pre < 6; pre++) {
      const inner = Buffer.concat([randomBytes(pre), Buffer.from(needle, "utf8"), randomBytes(pre % 4)]);
      for (const enc of ["base64", "base64url"] as const) {
        for (const s of [inner.toString(enc), inner.toString(enc).replace(/=+$/, "")]) expect(leakedIn([wrap(s)], [needle]).length).toBeGreaterThan(0);
      }
    }
  });

  test("hex、encodeURIComponent、逐字节 %xx、JSON \\uXXXX：全小写、全大写、逐位大小写混用都抓得到", () => {
    const b = Buffer.from(needle, "utf8"), hex = b.toString("hex"), pct = hex.replace(/../g, "%$&");
    const u = Array.from({ length: needle.length }, (_, i) => `\\u${needle.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");
    const mixed = (s: string) => s.replace(/[a-f]/gi, (c, i: number) => (i % 2 ? c.toUpperCase() : c.toLowerCase()));
    const uri = (f: (s: string) => string) => encodeURIComponent(needle).replace(/%[0-9A-F]{2}/g, f); // 只动转义里的十六进制，明文部分是原文
    const forms = [hex, pct, u].flatMap((f) => [f, f.replace(/[a-f]/g, (c) => c.toUpperCase()), mixed(f)]).concat(uri((x) => x), uri((x) => x.toLowerCase()), uri(mixed));
    for (const f of forms) expect(leakedIn([wrap(f)], [needle])).not.toEqual([]);
    expect(leakedIn([Buffer.from(JSON.stringify({ v: needle }), "utf8")], [needle])).toEqual([`${needle} (raw)`]);
  });

  test("随机字节和它们的 base64 里不误报", () => {
    const noise = Array.from({ length: 50 }, () => randomBytes(4096));
    expect(leakedIn([...noise, ...noise.map((n) => Buffer.from(n.toString("base64")))], [needle, mark("tok"), "/api/v1/agents/x/messages"])).toEqual([]);
  });

  test("短 needle 直接报错，不让它在密文里偶然撞上", () => {
    expect(() => leakedIn([], ["tok"])).toThrow("too short");
  });
});
