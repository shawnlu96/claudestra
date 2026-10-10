/** Bundle the real list/store with an isolated transport so the concurrency regression also runs without Chrome. */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { AgentSession } from "@/lib/chat/agents";

interface Harness {
  loadAgents(): Promise<AgentSession[]>;
  clearUnreadCounts(): void;
  unreadSnapshot(): { total: number };
  requests: Array<(counts: Record<string, number>) => void>;
  switchMachine(fp: string): void;
}
const fixture = `
export const requests=[];
let fp='A';const switches=[];
export const machines={currentFp:()=>fp,onSwitch:cb=>switches.push(cb)};
export function switchMachine(next){const prev=fp;fp=next;for(const cb of switches)cb(prev,next)}
export class ApiError extends Error {}
export const api=async()=>({ok:true,agents:[{name:'agent-a'},{name:'b'},{name:'master',runtime:'claude'}]});
export const fetchUnread=()=>new Promise(resolve=>requests.push(resolve));
`;
let serial = 0;
async function harness(): Promise<Harness> {
  const entry = resolve("node_modules/.cache/unread-race-entry.ts");
  const result = await Bun.build({ entrypoints: [entry], target: "bun", plugins: [{
    name: "unread-race-transport", setup(b) {
      b.onResolve({ filter: /unread-race-entry\.ts$/ }, () => ({ path: entry, namespace: "entry" }));
      b.onLoad({ filter: /.*/, namespace: "entry" }, () => ({ loader: "ts", resolveDir: process.cwd(), contents: `
        export {loadAgents} from '${resolve("web/lib/chat/agents.ts")}';
        export {clearUnreadCounts,unreadSnapshot} from '${resolve("web/lib/push/unread-counts.ts")}';
        export {requests,switchMachine} from 'unread-fixture';
      ` }));
      b.onResolve({ filter: /^(unread-fixture|@\/lib\/(api\/(client|push)|machines))$/ }, () => ({ path: "transport", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: fixture, loader: "js" }));
    },
  }] });
  expect(result.success).toBe(true);
  const file = resolve(`node_modules/.cache/unread-race-${serial++}.mjs`);
  await Bun.write(file, await result.outputs[0].text());
  return import(file) as Promise<Harness>;
}
const unread = (rows: AgentSession[]) => rows.filter((a) => !a.pinnedMaster).map((a) => a.unread);

test("[验收线 2] concurrent loadAgents callers retain unread in both response orders", async () => {
  for (const reverse of [false, true]) {
    const h = await harness(), first = h.loadAgents(), second = h.loadAgents();
    expect(h.requests.length).toBe(2);
    const order = reverse ? [1, 0] : [0, 1];
    h.requests[order[0]]({ a: 2, b: 1 });
    await (reverse ? second : first);
    h.requests[order[1]]({ a: 2, b: 1 });
    expect(unread(await first)).toEqual([2, 1]);
    expect(unread(await second)).toEqual([2, 1]);
    expect(h.unreadSnapshot().total).toBe(3);
  }
});

test("[验收线 2] late older response uses newer counts; manual clear and machine switch invalidate pending reads", async () => {
  const h = await harness(), first = h.loadAgents(), second = h.loadAgents();
  h.requests[1]({ a: 5 });await second;
  h.requests[0]({ a: 2 });
  expect(unread(await first)).toEqual([5, 0]);expect(h.unreadSnapshot().total).toBe(5);
  const cleared = h.loadAgents();h.clearUnreadCounts();h.requests[2]({ a: 9 });
  expect(unread(await cleared)).toEqual([0, 0]);expect(h.unreadSnapshot().total).toBe(0);
  const oldMachine = h.loadAgents();h.switchMachine("B");
  const newMachine = h.loadAgents();h.requests[4]({ b: 3 });await newMachine;
  h.requests[3]({ a: 9 });
  expect(unread(await oldMachine)).toEqual([0, 0]);expect(h.unreadSnapshot().total).toBe(3);
});
