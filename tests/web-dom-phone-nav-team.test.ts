/**
 * NAVBAR1 验收线 7（先红后绿）：「会话」列表里不再出现团队区，团队项目只在「团队」入口页；本机项目分组照旧。
 * 只挂真的 Sidebar（happy-dom，夹具 tests/helpers/nav-shots.ts：一个团队项目绑在本机「合成项目 A」上，本机也有这个项目的分组），
 * 不 import nav/ 下的任何模块，同一个文件放到改前的 main 上跑会红（团队区还在列表里）。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { navDom } from "./helpers/nav-shots";

let dom: Awaited<ReturnType<typeof navDom>>;
beforeAll(async () => { dom = await navDom({}); });
afterEach(async () => dom.cleanup());
afterAll(async () => dom.dispose());

for (const width of [1280, 390]) {
  test(`[验收线 7] ${width}：会话列表里没有团队区，本机项目分组照旧`, async () => {
    const v = await dom.mount(width);
    // 绑定读到了（项目组「合成项目 A」已经认出是团队项目、带「团队」小标），再给团队区自己那份快照留出回包时间（改前它在这段时间里出现）
    await v.until(() => v.all("[data-collab-team-badge]").length > 0, "team binding settled");
    await dom.tick(300);
    const list = v.host.querySelector("aside .overflow-y-auto")!;
    expect(list.querySelector("section[aria-label='团队项目']")).toBeNull();
    // 本机项目分组照旧：两个成组项目各一行「协作视图」，绑定团队的那个带「团队」小标
    expect(v.texts("aside .overflow-y-auto [data-collab-team-badge]")).toEqual(["团队"]);
    expect((list.textContent ?? "").match(/协作视图/g)).toHaveLength(2);
    await v.unmount();
  });
}
