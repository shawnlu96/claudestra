/**
 * 订阅额度调度测试的共用夹具：真实 QuotaScheduler + 假时钟 / 凭据 / fetch / 存储（tests/quota-scheduler*.test.ts）。
 */

import { confirmCredential, hmacHex, peekAccountKey, readClaudeCredential, readCodexCredential } from "../src/lib/quota-credentials.js";
import { QuotaScheduler } from "../src/lib/quota-scheduler.js";
import { memoryQuotaStore, type QuotaStore } from "../src/lib/quota-state.js";
import { SECRET, T0, fakeCredDeps, fakeFetch, okRoutes } from "./quota-fixtures.js";

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export type Route = (url: string, signal: AbortSignal) => Response | Promise<Response>;
export interface Harness {
  now: number;
  enabled: boolean;
  claudeBg: boolean;
  cd: ReturnType<typeof fakeCredDeps>;
  fetch: ReturnType<typeof fakeFetch>;
  route: Route;
  store: QuotaStore;
  scheduler: QuotaScheduler;
  advance(ms: number): void;
  fresh(): QuotaScheduler;
}

export function harness(route: Route = okRoutes, store: QuotaStore = memoryQuotaStore()): Harness {
  const h: Harness = {
    now: T0,
    enabled: true,
    claudeBg: false,
    cd: fakeCredDeps(),
    fetch: fakeFetch((u, s) => h.route(u, s)),
    route,
    store,
    scheduler: null as unknown as QuotaScheduler,
    advance(ms: number) {
      h.now += ms;
    },
    fresh() {
      h.scheduler = new QuotaScheduler({
        now: () => h.now,
        random: () => 0.5,
        fetch: h.fetch,
        readCredential: (p) => (p === "claude" ? readClaudeCredential(h.cd) : readCodexCredential(h.cd)),
        confirmCredential: (c) => confirmCredential(c, h.cd),
        peekAccountKey: (p) => peekAccountKey(p, h.cd),
        hashCreditId: (acct, id) => hmacHex(SECRET, acct, id),
        store: h.store,
        isEnabled: () => h.enabled,
        claudeBackground: () => h.claudeBg,
      });
      return h.scheduler;
    },
  };
  h.fresh();
  return h;
}

