/**
 * 共享 ACP 契约套件的驱动：contract.test.ts 对 DRIVERS 里每一个跑同一组场景。驱动只负责起一份连着适配器的 AcpSession，
 * 并给出各场景要发的 prompt 和期望；场景本身不认识具体适配器。
 * - stub：真子进程 scripts/acp-stub.ts（照 codex-acp 的形状）；
 * - pi-replay：真 Pi 适配器 + 回放 pi 0.99.1 录制流（pi-replay.ts）；
 * - 以后的 Codex 回放驱动（录下的 app-server stdio 接真 codex-acp 产物）照 ContractDriver 实现、加进 DRIVERS，场景不用改。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter } from "../../src/lib/acp/adapter-proc.ts";
import type { AcpFailure } from "../../src/lib/acp/failures.ts";
import type { RpcWire } from "../../src/lib/acp/rpc.ts";
import { AcpSession } from "../../src/lib/acp/session.ts";
import { repoStubPath } from "../../src/lib/acp/stub.ts";
import { assistant, cmd, CWD, FIXTURE, harnessWith, ok, out, promptLine, type Line, type Rec } from "./pi-replay.ts";

/** 场景：回放驱动按它挑录制流（每场一段），活的驱动用不上 */
export type Scene = "initialize" | "attach" | "text" | "cancel" | "fail";

export interface ContractRun {
  session: AcpSession;
  /** 这个会话收到的全部 session/update（原样） */
  updates: Rec[];
  /** attach 接回哪个线程、在哪个目录 */
  sessionId: string;
  cwd: string;
  /** 驱动自己的完整性问题（回放：适配器发出的命令和录的对不上）；空 = 没问题 */
  problems(): string[];
  close(): Promise<void>;
}

export interface ContractDriver {
  readonly name: string;
  /** text 要回出含 reply 的正文；slow 先出一个工具调用、一直跑到被叫停；fail 以 kind 这种失败收尾 */
  readonly turns: { text: { prompt: string; reply: string }; slow: string; fail: { prompt: string; kind: AcpFailure["kind"] } };
  /** wrap：宿主一侧的线路先过它再交给 AcpSession（场景用它看 / 改 initialize 回包） */
  open(scene: Scene, wrap: (w: RpcWire) => RpcWire): Promise<ContractRun>;
}

const stubDriver: ContractDriver = {
  name: "stub",
  turns: { text: { prompt: "在吗", reply: "stub 收到了" }, slow: "[stub:slow] 慢慢来", fail: { prompt: "[stub:quota] 干活", kind: "quota" } },
  async open(_scene, wrap) {
    const stub = repoStubPath();
    if (!stub) throw new Error("缺 ACP stub（scripts/acp-stub.ts）");
    const root = mkdtempSync(join(tmpdir(), "acp-contract-"));
    const proc = spawnAdapter([process.execPath, stub], { ...process.env, CODEX_CONFIG: "{}", APP_SERVER_LOGS: root }, root, () => {});
    const updates: Rec[] = [];
    const session = new AcpSession(wrap(proc.wire), { onUpdate: (u) => void updates.push(u), onPermission: async () => null, log: () => {} });
    const close = async () => {
      proc.stop();
      await proc.exited;
      rmSync(root, { recursive: true, force: true });
    };
    return { session, updates, sessionId: "019a0000-0000-7000-8000-0000000c0de0", cwd: root, problems: () => [], close };
  },
};

/** 录制流里第一条满足 pred 的命令（适配器发给 pi 的）的下标 */
const inAt = (pred: (r: Rec) => boolean) => FIXTURE.findIndex((l) => l.d === "in" && pred(l.r));
const STARTUP_END = inAt((r) => r.type === "prompt");
const TURN1_END = inAt((r) => r.type === "get_session_stats") + 2; // 第一回合之后的用量查询连同它的回包
const SLOW = inAt((r) => r.type === "prompt" && String(r.message).startsWith("Run `sleep 30`"));
const startup = FIXTURE.slice(0, STARTUP_END);

/** 每个场景消费的录制流：启动三问开头，第一回合（bash + reply + done）、「sleep 30 → 打断」两段原样取自录制，失败那段手写（同 pi rpc 形状） */
const PI_SCENES: Record<Scene, Line[][]> = {
  initialize: [],
  attach: [startup],
  text: [FIXTURE.slice(0, TURN1_END)],
  cancel: [[...startup, ...FIXTURE.slice(SLOW)]],
  fail: [[
    ...startup, promptLine("p4", "boom"), ok("p4", "prompt", { disposition: "started" }), out({ type: "agent_start" }),
    assistant({ stopReason: "error", errorMessage: "529 overloaded" }), out({ type: "agent_end", messages: [], willRetry: false }),
    out({ type: "agent_settled" }), cmd({ type: "get_session_stats", id: "p5" }), ok("p5", "get_session_stats", {}),
  ]],
};

const piReplayDriver: ContractDriver = {
  name: "pi-replay（pi 0.99.1）",
  turns: { text: { prompt: String(FIXTURE[STARTUP_END]!.r.message), reply: "done" }, slow: String(FIXTURE[SLOW]!.r.message), fail: { prompt: "boom", kind: "error" } },
  async open(scene, wrap) {
    const h = harnessWith({ wrap }, ...PI_SCENES[scene]);
    return {
      session: h.session, updates: h.updates, sessionId: "sid-replay", cwd: CWD,
      problems: () => h.pis.flatMap((p) => p.mismatches), close: async () => h.hostWire.close("契约场景结束"),
    };
  },
};

export const DRIVERS: readonly ContractDriver[] = [stubDriver, piReplayDriver];
