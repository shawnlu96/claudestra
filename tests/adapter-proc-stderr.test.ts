/** 适配器 stderr 按完整行打码（lib/acp/adapter-proc.ts stderrLines）：密钥跨 chunk、到 EOF 才结束、超长行都不漏没打码的碎片 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter, stderrLines } from "../src/lib/acp/adapter-proc.ts";
import { testChildEnv } from "./test-env.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const collect = (maxLine?: number) => {
  const lines: string[] = [];
  return { lines, s: stderrLines((l) => lines.push(l), maxLine) };
};
const SECRET = "sk-abcdefghijklmnopqrstuvwx1234";

describe("stderrLines", () => {
  test("密钥拆在两个 chunk 里：拼成整行再打码，只出一行", () => {
    const { lines, s } = collect();
    s.push(enc("key sk-abc"));
    s.push(enc("defghijklmnopqrstuvwx1234 done\nnext"));
    expect(lines).toEqual(["key [redacted] done"]);
    s.end();
    expect(lines).toEqual(["key [redacted] done", "next"]);
  });

  test("最后一行没有换行就到 EOF：end 时整行打码再出", () => {
    const { lines, s } = collect();
    s.push(enc("token="));
    s.push(enc("abcd1234efgh"));
    expect(lines).toEqual([]);
    s.end();
    expect(lines).toEqual(["token=[redacted]"]);
  });

  test("多字节字符跨 chunk 不乱码", () => {
    const { lines, s } = collect();
    const bytes = enc("中文日志\n");
    s.push(bytes.slice(0, 1));
    s.push(bytes.slice(1));
    expect(lines).toEqual(["中文日志"]);
  });

  test("超长行没结束：内容一个字都不记（引号没闭合时打码认不出边界），只记占位；剩下的到换行为止都丢，下一行照常", () => {
    const { lines, s } = collect(32);
    s.push(enc('password="hunter2 extra-secret-words-here'));
    s.push(enc(`${SECRET} tail"\nok\n`));
    expect(lines).toEqual(["[一行超过 32 字还没换行，内容略去]", "ok"]);
  });

  test("缺省上限下也一样：16KB 的引号没闭合的值不漏（Shawn r4）", () => {
    const { lines, s } = collect();
    s.push(enc(`password="hunter2 ${"word ".repeat(4000)}`));
    expect(lines).toEqual(["[一行超过 16384 字还没换行，内容略去]"]);
  });
});

test("真子进程：密钥分两次写进 stderr（中间 sleep），日志里只有一行打过码的（Shawn r3 探针）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adapter-stderr-"));
  try {
    const logs: string[] = [];
    const proc = spawnAdapter(["sh", "-c", `printf 'sk-abc' >&2; sleep 0.2; printf 'defghijklmnopqrstuvwx1234\\n' >&2; printf 'no newline token=abcd1234' >&2`],
      testChildEnv(), dir, (m) => logs.push(m), "t");
    await proc.exited;
    for (let i = 0; i < 40 && logs.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    expect(logs).toEqual(["[t] [redacted]", "[t] no newline token=[redacted]"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
