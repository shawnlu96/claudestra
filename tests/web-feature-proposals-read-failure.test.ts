/**
 * UXINBOX1 验收线 4：团队标签提案区读失败按状态码写固定原因（不回显中心 / bridge 原文）；owner 设备上本人待批的提案写「待你批准」。
 * 控制器是纯逻辑直接测；页面在子进程里 SSR 真组件（同 web-team-work-model.test.ts），假 port、不出网。
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { FeatureProposalsPort, ProposalAccess, Reply } from "../web/lib/feature-proposals-api";
import { ProposalsController, loadFailureText, readFailureText, rereadOffered } from "../web/lib/feature-proposals-controller";
import { featureProposalsTr } from "../web/lib/i18n-dict-feature-proposals";
import { testChildEnv } from "./test-env";

const PROJECT = "project-demo";
const RAW = "upstream said: Bearer sk-RAW-CENTER-TEXT person-zed";
const OK: Reply = { status: 200, body: { ok: true, proposals: [] } };
const fail = (status: number): Reply => ({ status, body: { ok: false, error: RAW, message: RAW } });

function port(o: { access?: ProposalAccess; review?: Reply }) {
  const state = { access: o.access ?? { status: 200, role: "owner", localProjectId: "proj-bound" } as ProposalAccess, review: o.review ?? OK };
  const p: FeatureProposalsPort = {
    submit: async () => fail(500), operation: async () => fail(500), decide: async () => fail(500),
    operations: async () => ({ status: 200, body: { ok: true, operations: [] } }),
    access: async () => state.access, review: async () => state.review,
  };
  return { p, state };
}
async function loaded(o: Parameters<typeof port>[0]) {
  const f = port(o), ctrl = new ProposalsController(f.p, PROJECT, () => 1_800_000_000_000);
  await ctrl.poll();
  return { ...f, ctrl };
}

const TEXT: [number, string][] = [[404, "中心或本机 bridge 没有提案接口"], [429, "读得太频繁，稍后自动重读"], [500, "中心暂时不可用"], [503, "中心暂时不可用"],
  [504, "中心暂时不可用"], [0, "连不上本机 bridge"]];

describe("[验收线 4] 读失败：状态码存下来再映射成固定文字", () => {
  test("404 / 429 / 5xx（502 除外）/ 网络错误各有固定文字；其余仍是「读取失败」；每条都有英文词条", () => {
    for (const [status, text] of TEXT) expect(readFailureText(status)).toBe(text);
    for (const status of [null, 400, 418, 502]) expect(readFailureText(status)).toBe("读取失败");
    const en = featureProposalsTr("en");
    for (const text of [...new Set(TEXT.map(([, t]) => t)), "待你批准", "去处理"]) expect(en(text)).not.toBe(text);
  });

  test("待审列表读失败：review=failed、failStatus=状态码、给重读入口；回包原文不进状态", async () => {
    for (const [status, text] of TEXT) {
      const { ctrl } = await loaded({ review: fail(status) });
      expect(ctrl.get()).toMatchObject({ access: "ready", review: "failed", failStatus: status });
      expect(readFailureText(ctrl.get().failStatus)).toBe(text);
      expect(rereadOffered(ctrl.get())).toBe(true);
      expect(JSON.stringify(ctrl.get())).not.toContain("RAW-CENTER-TEXT");
    }
  });

  test("角色读失败（snapshot）同样带状态码", async () => {
    for (const [status, text] of TEXT) {
      const { ctrl } = await loaded({ access: { status, role: null, localProjectId: null } });
      expect(ctrl.get()).toMatchObject({ access: "failed", role: null, failStatus: status });
      expect(readFailureText(ctrl.get().failStatus)).toBe(text);
    }
  });

  test("403 / 502 照旧走各自的状态，不记读失败码", async () => {
    expect((await loaded({ review: fail(403) })).ctrl.get()).toMatchObject({ review: "forbidden", role: null, failStatus: null });
    expect((await loaded({ review: fail(502) })).ctrl.get()).toMatchObject({ review: "unsupported", failStatus: null });
    expect((await loaded({ access: { status: 403, role: null, localProjectId: null } })).ctrl.get()).toMatchObject({ access: "forbidden", review: "forbidden", failStatus: null });
  });

  test("读回来之后清掉：429 → 成功 → failStatus null；列表仍失败时角色读成功不清", async () => {
    const { ctrl, state } = await loaded({ review: fail(429) });
    await ctrl.poll();
    expect(ctrl.get()).toMatchObject({ access: "ready", review: "failed", failStatus: 429 });
    state.review = OK;
    await ctrl.poll();
    expect(ctrl.get()).toMatchObject({ review: "ready", failStatus: null });
    state.access = { status: 0, role: null, localProjectId: null };
    await ctrl.poll();
    expect(ctrl.get()).toMatchObject({ access: "failed", failStatus: 0 });
  });

  test("连续两轮：上一轮列表 403 / 502，这一轮角色读失败 → 列表没重读、旧状态还在，但原因按这一轮的状态码说", async () => {
    for (const [stale, kept] of [[403, "forbidden"], [502, "unsupported"]] as const) {
      for (const [status, text] of TEXT) {
        const { ctrl, state } = await loaded({ review: fail(stale) });
        expect(ctrl.get()).toMatchObject({ access: "ready", review: kept, failStatus: null });
        state.access = { status, role: null, localProjectId: null };
        await ctrl.poll();
        expect(ctrl.get()).toMatchObject({ access: "failed", review: kept, role: null, failStatus: status });
        expect(loadFailureText(ctrl.get())).toBe(text);
        expect(rereadOffered(ctrl.get())).toBe(true);
      }
    }
  });

  test("连续两轮：角色 403 之后读失败说这一轮的原因；角色读回来、列表仍 403 / 502 时回到各自的文字；读成功后没有原因", async () => {
    const { ctrl, state } = await loaded({ access: { status: 403, role: null, localProjectId: null } });
    expect(loadFailureText(ctrl.get())).toBe("待审列表需要本机 owner 设备（403）");
    state.access = { status: 429, role: null, localProjectId: null };
    await ctrl.poll();
    expect(loadFailureText(ctrl.get())).toBe("读得太频繁，稍后自动重读");
    state.access = { status: 200, role: "owner", localProjectId: "proj-bound" };
    state.review = fail(502);
    await ctrl.poll();
    expect(loadFailureText(ctrl.get())).toBe("中心不支持提案协议（502）");
    state.review = fail(403);
    await ctrl.poll();
    expect(loadFailureText(ctrl.get())).toBe("待审列表需要本机 owner 设备（403）");
    state.access = { status: 200, role: "owner", localProjectId: null };
    await ctrl.poll();
    expect(loadFailureText(ctrl.get())).toBe("本机未绑定该团队项目");
    state.access = { status: 200, role: "owner", localProjectId: "proj-bound" };
    state.review = OK;
    await ctrl.poll();
    expect(loadFailureText(ctrl.get())).toBeNull();
  });
});

/** 真 ProposalsPanel：先让同一身份的控制器（按 identityKey 共用）读完一轮，再 SSR */
function renderPanel(o: { status?: number; accessStatus?: number; role?: "owner" | "member"; pending?: boolean; thenAccess?: number }): string {
  const script = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { identityKey } from './lib/api/shared-ledger';
    import { ProposalsController, proposalsController } from './lib/feature-proposals-controller';
    import { ProposalsPanel } from './features/collab/feature-proposals/proposals-view.tsx';
    const o = ${JSON.stringify(o)}, RAW = ${JSON.stringify(RAW)};
    const identity = { center: 'c', team: 't', person: 'person-a', project: ${JSON.stringify(PROJECT)}, machine: 'local' };
    const bad = (status) => ({ status, body: { ok: false, error: RAW, message: RAW } });
    const op = { operationId: 'op-1', projectId: identity.project, title: '卡片工作优先级', state: 'pending_approval', issue: null, expiresAt: 1800000060000 };
    let round = 0;
    const port = {
      submit: async () => bad(500), operation: async () => bad(500), decide: async () => bad(500),
      operations: async () => ({ status: 200, body: { ok: true, operations: o.pending ? [op] : [] } }),
      access: async () => o.thenAccess !== undefined && round++ > 0 ? { status: o.thenAccess, role: null, localProjectId: null }
        : o.accessStatus !== undefined ? { status: o.accessStatus, role: null, localProjectId: null }
        : { status: 200, role: o.role ?? 'owner', localProjectId: 'proj-bound' },
      review: async () => o.status === undefined ? { status: 200, body: { ok: true, proposals: [] } } : bad(o.status),
    };
    const ctrl = proposalsController(identityKey(identity), () => new ProposalsController(port, identity.project, () => 1800000000000));
    await ctrl.poll();
    if (o.thenAccess !== undefined) await ctrl.poll();
    console.log(renderToStaticMarkup(createElement(ProposalsPanel, { identity, port })));
  `;
  const p = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: resolve(import.meta.dir, "../web"), env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
  expect(p.stderr.toString().split("\n").filter((l) => l.trim() && !l.startsWith("Invalid value for prop `className`"))).toEqual([]);
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}

describe("[验收线 4] 团队标签提案区的 DOM", () => {
  test("404 / 429 / 5xx / 网络错误：各显示对应固定文字，不再只写「读取失败」，DOM 里没有回包原文；仍给「重读列表」", () => {
    for (const [status, text] of TEXT) {
      const html = renderPanel({ status });
      expect(html).toContain(text);
      expect(html).not.toContain("读取失败");
      expect(html).toContain("重读列表");
      expect(html).not.toMatch(/RAW-CENTER-TEXT|upstream said|Bearer|person-zed/);
    }
    expect(renderPanel({ accessStatus: 429 })).toContain("读得太频繁，稍后自动重读");
  });

  test("403 / 502 的文字照旧", () => {
    expect(renderPanel({ status: 403 })).toContain("待审列表需要本机 owner 设备（403）");
    expect(renderPanel({ status: 502 })).toContain("中心不支持提案协议（502）");
  });

  test("连续两轮：上一轮列表 403 / 502、这一轮角色读失败 → DOM 写这一轮的固定原因，不再是上一轮的 403 / 502 文字", () => {
    for (const [status, old] of [[403, "待审列表需要本机 owner 设备（403）"], [502, "中心不支持提案协议（502）"]] as const) {
      for (const [thenAccess, text] of TEXT) {
        const html = renderPanel({ status, thenAccess });
        expect(html).toContain(text);
        expect(html).not.toContain(old);
        expect(html).toContain("重读列表");
        expect(html).not.toMatch(/RAW-CENTER-TEXT|upstream said|Bearer|person-zed/);
      }
    }
  });

  test("owner 设备：「我的提案」里待批的那条写「待你批准」，不写「待项目 owner 批准」；member 设备照旧", () => {
    const owner = renderPanel({ role: "owner", pending: true });
    expect(owner).toContain("卡片工作优先级");
    expect(owner).toContain("待你批准");
    expect(owner).not.toContain("待项目 owner 批准");
    const member = renderPanel({ role: "member", pending: true });
    expect(member).toContain("已提交，待项目 owner 批准");
    expect(member).not.toContain("待你批准");
  });
});
