/**
 * 共享 ACP 契约：宿主真用的 AcpSession、协议检查（lib/acp/protocol.ts）和翻译器，对每个驱动（drivers.ts）跑同一组场景——
 * initialize 与协议检查、接回线程、一轮文字回复、叫停、失败上报。场景只用驱动给的 prompt 和期望，不认识具体适配器；
 * 拒起的几种回包由场景在宿主一侧的线路上改写，所以每个驱动都按它真实回包的形状验一遍。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ACP_PROTOCOL_VERSION, AcpIncompatibleError } from "../../src/lib/acp/protocol.ts";
import type { RpcWire } from "../../src/lib/acp/rpc.ts";
import { createAcpTranslator } from "../../src/lib/acp/updates.ts";
import { DRIVERS, type ContractDriver, type ContractRun, type Scene } from "./drivers.ts";
import { until, type Rec } from "./pi-replay.ts";

let run: ContractRun | null = null;
afterEach(async () => {
  await run?.close();
  run = null;
});

/** 宿主一侧的线路：记下 initialize 的原始回包；edit 给了就按它改写后再交给 AcpSession */
function tapInitialize(edit?: (r: Rec) => Rec) {
  let raw: Rec | undefined;
  const wrap = (w: RpcWire): RpcWire => {
    let initId: unknown;
    let buf = "";
    const dec = new TextDecoder();
    const fix = (line: string) => {
      const m = JSON.parse(line);
      if (m.id === undefined || m.id !== initId || !m.result) return line;
      raw = m.result;
      return edit ? JSON.stringify({ ...m, result: edit(m.result) }) : line;
    };
    return {
      write: (line) => {
        const m = JSON.parse(line);
        if (m.method === "initialize") initId = m.id;
        w.write(line);
      },
      onData: (cb) => w.onData((chunk) => {
        const lines = (buf + (typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true }))).split("\n");
        buf = lines.pop() ?? "";
        const whole = lines.filter((l) => l.trim()).map(fix);
        if (whole.length) cb(`${whole.join("\n")}\n`);
      }),
      onClose: (cb) => w.onClose(cb),
      close: (why) => w.close(why),
    };
  };
  return { wrap, raw: () => raw };
}

async function opened(d: ContractDriver, scene: Scene, edit?: (r: Rec) => Rec) {
  const tap = tapInitialize(edit);
  run = await d.open(scene, tap.wrap);
  return { run, raw: tap.raw };
}

async function attached(d: ContractDriver, scene: Scene): Promise<ContractRun> {
  const { run: r } = await opened(d, scene);
  const caps = await r.session.initialize();
  await r.session.attach(r.sessionId, r.cwd, caps.resume);
  return r;
}

const MUTATIONS: [string, (r: Rec) => Rec][] = [
  ["protocolVersion 改成 2", (r) => ({ ...r, protocolVersion: 2 })],
  ["去掉 protocolVersion", ({ protocolVersion: _drop, ...r }) => r],
  ["resume 与 loadSession 都没有", (r) => ({ ...r, agentCapabilities: { ...r.agentCapabilities, loadSession: false, sessionCapabilities: {} } })],
];

for (const d of DRIVERS) {
  describe(`ACP 契约 · ${d.name}`, () => {
    test("initialize：回 ACP v1、报身份、能接回线程；fork 只在要 fork 时才要求", async () => {
      const { run: r, raw } = await opened(d, "initialize");
      const caps = await r.session.initialize();
      expect(raw()?.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
      expect(caps.resume || raw()?.agentCapabilities?.loadSession === true).toBe(true);
      expect(r.session.agentInfo?.name).toBeString();
      const forkDeclared = !!raw()?.agentCapabilities?.sessionCapabilities?.fork;
      const forkCheck = r.session.initialize({ fork: true });
      if (forkDeclared) expect(await forkCheck).toMatchObject({ fork: true });
      else await expect(forkCheck).rejects.toBeInstanceOf(AcpIncompatibleError);
    });

    for (const [what, edit] of MUTATIONS) {
      test(`initialize 回包「${what}」：拒起（AcpIncompatibleError，原因写明）`, async () => {
        const { run: r } = await opened(d, "initialize", edit);
        const err = await r.session.initialize().catch((e) => e);
        expect(err).toBeInstanceOf(AcpIncompatibleError);
        expect(err.message).toContain("协议不兼容，拒绝启动");
      });
    }

    test("attach：接回已有线程，拿到配置项", async () => {
      const r = await attached(d, "attach");
      expect(r.session.sessionId).toBe(r.sessionId);
      expect(r.session.configOptions.length).toBeGreaterThan(0);
      expect(r.problems()).toEqual([]);
    });

    test("prompt：一轮跑完，收到文字回复", async () => {
      const r = await attached(d, "text");
      expect(await r.session.prompt(d.turns.text.prompt)).toEqual({ kind: "done" });
      const tr = createAcpTranslator(() => "T");
      const texts = [...r.updates.flatMap((u) => tr.push(u)), ...tr.flush()].map((e) => e.message?.content?.[0]).filter((b) => b?.type === "text");
      expect(texts.map((b) => b.text).join("")).toContain(d.turns.text.reply);
      expect(r.problems()).toEqual([]);
    });

    test("取消：在跑的回合叫停 → cancelled", async () => {
      const r = await attached(d, "cancel");
      const turn = r.session.prompt(d.turns.slow);
      await until(() => r.updates.some((u) => u.sessionUpdate === "tool_call"), "慢回合的工具调用", 10_000);
      await r.session.cancel();
      expect(await turn).toEqual({ kind: "cancelled" });
      expect(r.problems()).toEqual([]);
    });

    test("失败：回合失败带着种类和原因报上来", async () => {
      const r = await attached(d, "fail");
      const res = await r.session.prompt(d.turns.fail.prompt);
      expect(res).toMatchObject({ kind: "failed", failure: { kind: d.turns.fail.kind } });
      expect(res.kind === "failed" && res.failure.message).toBeTruthy();
      expect(r.problems()).toEqual([]);
    });
  });
}
