/** bridge rescan（manager rename / create / resume / kill 后的 full 重扫）把可信登记的名字归属同步给各观察器。 */
import { relabelBgOwners } from "./bg-activity-watcher.js";
import { relabelChannelOwner } from "./jsonl-watcher.js";
import { trustedOwners } from "./watcher-ownership-gen.js";

/** 同频道同会话的只改挂名字（不重读尾、不丢未发正文）；没有可信频道 / 会话的条目不动。已结束 bg shell 的结果连落盘一起搬。返回原列表，rescan 接着用 */
export async function syncWatcherOwners<T>(agents: T[]): Promise<T[]> {
  const owners = trustedOwners(agents);
  let moved = 0;
  for (const o of owners) moved += relabelChannelOwner(o);
  moved += await relabelBgOwners(owners);
  if (moved) console.log(`👁 rescan 按登记改挂观察器归属：${moved} 处`);
  return agents;
}
