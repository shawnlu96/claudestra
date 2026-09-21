/**
 * 控制频道注册准入（2026-09-21：dev worktree 的大总管带着生产的 DISCORD_CHANNEL_ID
 * 起来，跟正主抢 #control 抢了三个多小时，10 分钟内互相顶替 19 次）。
 *
 * 判据只有一条：控制频道只认 cwd == MASTER_DIR 的实例。这里重点测**不误伤**
 * （正常重启、非控制频道、报不出 cwd 的老版本）和**软链等价**。
 */
import { describe, test, expect } from "bun:test";
import { checkControlRegistrant } from "../src/lib/control-registrant.js";

const CONTROL = "1494205949924348085";
const MASTER_DIR = "/Users/he/repos/claudestra/master";
const DEV_DIR = "/Users/he/repos/claudestra-dev/master";
const AGENT_CH = "1549060347875434517";

/** 单测里不碰真实文件系统：realpath 恒等，软链那格单独注入 */
const idRealpath = (p: string) => p;

const check = (o: Partial<Parameters<typeof checkControlRegistrant>[0]>) =>
  checkControlRegistrant({
    channelId: CONTROL,
    controlChannelId: CONTROL,
    masterDir: MASTER_DIR,
    realpath: idRealpath,
    ...o,
  });

describe("checkControlRegistrant", () => {
  test("正主（cwd == MASTER_DIR）放行——正常重启不能被误伤", () => {
    expect(check({ cwd: MASTER_DIR }).allow).toBe(true);
  });

  test("dev worktree 的大总管被挡下（本次事故的正主）", () => {
    const v = check({ cwd: DEV_DIR });
    expect(v.allow).toBe(false);
    expect(v.reason).toContain(DEV_DIR);
  });

  test("尾斜杠不算差异", () => {
    expect(check({ cwd: MASTER_DIR + "/" }).allow).toBe(true);
    expect(check({ cwd: MASTER_DIR, masterDir: MASTER_DIR + "//" }).allow).toBe(true);
  });

  test("软链等价 → 放行（MASTER_DIR 被搬出仓库时就是这形态）", () => {
    const rp = (p: string) => (p === "/Users/he/master-link" ? MASTER_DIR : p);
    expect(check({ cwd: "/Users/he/master-link", realpath: rp }).allow).toBe(true);
  });

  test("realpath 抛错 → 退回词法比较；对照物也没了就放行", () => {
    const boom = (p: string) => { throw new Error(`ENOENT ${p}`); };
    expect(check({ cwd: MASTER_DIR, realpath: boom }).allow).toBe(true);
    // MASTER_DIR 自己都解析不出来 ⇒ 没有可信对照物 ⇒ 放行（fail-open 第 4 条）
    expect(check({ cwd: DEV_DIR, realpath: boom }).allow).toBe(true);
  });

  // 2026-09-21 实测抓到的接线坑：MASTER_DIR 缺省是 `${REPO_ROOT}/master`，而
  // REPO_ROOT 自己带 `../..` ⇒ 拼出来是 `/…/src/bridge/../../master`。
  // 只 realpath、不做词法归一的话，目录解析不了时会拿这个原样字符串去比，
  // **连正主都被拒**。纯逻辑 fixture（路径都是干净的）发现不了，是拿真实
  // MASTER_DIR 跑了一遍才露出来的。
  test("MASTER_DIR 带 ../.. 也要认得出正主", () => {
    const messy = "/Users/he/repos/claudestra/src/bridge/../../master";
    expect(check({ cwd: MASTER_DIR, masterDir: messy }).allow).toBe(true);
    // 词法归一之后，dev 那个仍然该被拦
    const v = check({ cwd: DEV_DIR, masterDir: messy });
    expect(v.allow).toBe(false);
  });

  test("cwd 带 ../.. 同理", () => {
    expect(check({ cwd: "/Users/he/repos/claudestra/master/../master" }).allow).toBe(true);
  });

  // ── 三处 fail-open ──
  test("普通 agent 的频道一律不管（cwd 本来就各式各样）", () => {
    expect(check({ channelId: AGENT_CH, cwd: DEV_DIR }).allow).toBe(true);
  });

  test("没配 CONTROL_CHANNEL_ID → 放行", () => {
    expect(check({ controlChannelId: "", cwd: DEV_DIR }).allow).toBe(true);
  });

  test("注册帧不报 cwd（老版本 channel-server）→ 放行，不靠猜", () => {
    expect(check({ cwd: undefined }).allow).toBe(true);
    expect(check({ cwd: "" }).allow).toBe(true);
  });

  test("masterDir 为空 → 放行", () => {
    expect(check({ cwd: DEV_DIR, masterDir: "" }).allow).toBe(true);
  });
});
