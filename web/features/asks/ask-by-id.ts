/**
 * 引用条（components/ask-quote.tsx）按 id 单独取 ask 的缓存：抽屉列表里没有的（结案超过 3 天、别的机器）才取，同一条不重复取。
 * 只记住确定的结果——取到了，或 404（看不见 / 已删，引用条只写「答复」不带标题）。断网、超时、5xx 不记：
 * 记了的话这条引用条到关页面前一直没标题、点不了（tests/web-ask-by-id.test.ts）。
 */
import { ApiError } from "@/lib/api/client";
import { machines } from "@/lib/machines";
import type { WebAsk } from "./asks-model";
import { isAskForViewer } from "./ask-viewer";

export function askByIdCache(fetchOne: (id: string) => Promise<{ ask: WebAsk }>): (id: string) => Promise<WebAsk | null> {
  const fetched = new Map<string, Promise<WebAsk | null>>();
  return (id) => {
    const machine = machines.current();
    const key = `${machine?.fp ?? "local"}:${machine?.principalId ?? "owner:self"}:${id}`;
    let p = fetched.get(key);
    if (!p) {
      p = fetchOne(id).then(
        (r) => r.ask,
        (e) => {
          if (!(e instanceof ApiError && e.status === 404)) fetched.delete(key); // 下次挂载再取
          return null;
        },
      );
      fetched.set(key, p);
    }
    return p.then((ask) => ask && isAskForViewer(ask) ? ask : null);
  };
}
