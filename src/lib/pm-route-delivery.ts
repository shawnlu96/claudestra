import { classifyPmPush, PM_DIGEST_LABEL, type DigestInput, type DigestVerdict } from "./pm-digest.js";
import type { PmDigestStore } from "./pm-digest-store.js";
import { pmRouteConfigured } from "./pm-route-mode.js";
import { classifyPmRoute } from "./pm-route.js";
import { withPmRouteRecord } from "./pm-route-record.js";

/** 最终当班 PM 的同步分类口；不依赖 bridge 信封类型，也不改变其余投递生命周期。 */
interface RouteEnvelope {
  from: { kind: DigestInput["fromKind"] };
  intent: string;
  content: string;
  meta: { messageId: string; triggerKind: string; skipInterAgentWatchdog?: boolean };
}
interface Deps { store: PmDigestStore; now(): number }

function record(store: PmDigestStore, project: string, at: number, id: string, source: string,
  verdict: DigestVerdict, routeOnly: boolean, enqueue = false): void {
  const mode = store.mode(project);
  store.record({ at, project, mode, source, send: verdict.send, reason: verdict.reason,
    ...(verdict.send === "digest" ? { kind: verdict.kind } : {}), ...(routeOnly ? { routeOnly: true } : {}) },
  enqueue && verdict.send === "digest" ? { id, project, at, kind: verdict.kind, source: verdict.source, firstLine: verdict.firstLine,
    ...(verdict.card ? { card: verdict.card } : {}), ...(verdict.detail ? { detail: verdict.detail } : {}) } : undefined);
}

export function routePmPush(env: RouteEnvelope, project: string, deps: Deps, legacy: () => boolean,
  body: string, sender?: string): boolean {
  const { store } = deps, mode = store.routeMode(project);
  if (mode === "off" || (env.from.kind === "bridge" && sender === PM_DIGEST_LABEL)) return legacy();
  if (store.mode(project) === "off" && !pmRouteConfigured(store.modePath, project)) return legacy();
  const id = env.meta.messageId, source = sender ?? env.from.kind;
  const input: DigestInput = { fromKind: env.from.kind, sender, intent: env.intent,
    triggerKind: env.meta.triggerKind, oneShot: !!env.meta.skipInterAgentWatchdog, body };
  const plan = classifyPmRoute(input), original = env.content;
  return withPmRouteRecord({ messageId: id, mode, tags: plan.tags }, (scope) => {
    try {
      if (mode === "on" && plan.body === "") {
        record(store, project, deps.now(), id, source, classifyPmPush(input), true);
        return true; // 原子落盘完成才允许不投、不入队
      }
      if (mode === "on" && plan.body !== undefined && plan.body !== body) {
        env.content = `${original.slice(0, original.length - body.length)}${plan.body}`;
      }
      if (mode === "on" && plan.immediate) {
        const base = classifyPmPush(input);
        record(store, project, deps.now(), id, source, base.send === "now" ? base : {
          send: "now", reason: "route 保护项立即送",
        }, store.mode(project) === "off");
        return false;
      }
      if (mode === "on" && plan.digest) {
        const base = classifyPmPush(input), enqueue = store.mode(project) === "on";
        const verdict: DigestVerdict = base.send === "digest" ? base : {
          send: "digest", reason: "受信列车进度", kind: "sync", source, firstLine: body,
        };
        record(store, project, deps.now(), id, source, verdict, store.mode(project) === "off", enqueue);
        return enqueue;
      }
      const suppressed = legacy();
      if (!scope.recorded) record(store, project, deps.now(), id, source, classifyPmPush(input), true);
      return suppressed;
    } catch (e) {
      env.content = original; // 写失败的混合巡检必须以完整原信封走 PMDIG 的现有失败回退
      throw e;
    }
  });
}
