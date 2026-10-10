import { expect, test } from "bun:test";
import { generateHomeFixture, homeDagBoard } from "@/features/collab/shared/home-fixture-gen";
import { nodeCard, nodeTask, unopenedReason } from "@/features/collab/dag/node-card-model";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { teamFromHome } from "./web-team-parity-browser-center.test";

const fixture = () => homeDagBoard(generateHomeFixture()).features[0]!;
test("unopened reasons: unmet prerequisites precede missing files, paused feature and ready-to-open", () => {
  const f = fixture(), n = f.nodes.at(-1)!;
  f.status = "paused"; n.fileGlobs = [];
  expect(unopenedReason(f, n)).toEqual({ text: "前置没满足：{deps}", deps: "i28-A7" });
  f.nodes.find(dep => dep.key === "i28-A7")!.satisfied = true;
  expect(unopenedReason(f, n)).toEqual({ text: "没写文件范围" });
  n.fileGlobs = ["web/**"];
  expect(unopenedReason(f, n)).toEqual({ text: "feature 已暂停" });
  f.status = "active";
  expect(unopenedReason(f, n)).toEqual({ text: "前置都已满足，还没开卡" });
  n.deps = ["not-in-this-feature"];
  expect(unopenedReason(f, n)).toEqual({ text: "前置没满足：{deps}", deps: "not-in-this-feature" });
});
test("team board ready=true does not satisfy an unmet planned-node dependency", async () => {
  const home = generateHomeFixture(), team = await teamFromHome(home), details = new Map(team.details.map(d => [d.feature.id, d]));
  const ov = teamOverview(team.list, details, home.now);
  const f = teamDagBoard(home.project, team.list, details, ov).features.find(f => f.nodes.some(n => n.key === "i28-A8"))!, n = f.nodes.find(n => n.key === "i28-A8")!;
  n.ready = true; // Exercise the permissive readiness projection independently of satisfied.
  expect(n.taskId).toBeNull();
  expect(unopenedReason(f, n)).toEqual({ text: "前置没满足：{deps}", deps: "i28-A7" });
});
test("card bindings use only current nodes, skip missing cards and leave legacy cards untouched", () => {
  const f = fixture();
  expect(nodeCard([f], "i28-A5")?.node.key).toBe("i28-A5");
  expect(nodeCard([f], "T12")).toBeNull();
  expect(nodeCard([f], null)).toBeNull();
  f.nodes.find(n => n.taskId === "i28-A5")!.missing = true;
  expect(nodeCard([f], "i28-A5")).toBeNull();
  f.currentVersion = 0;
  expect(nodeCard([f], "i28-A4")).toBeNull();
});
test("node clicks open a present project card, while planned, missing, comparison and absent cards retain node pages", () => {
  const f = fixture(), tasks = generateHomeFixture().overview.tasks;
  expect(nodeTask(f, "i28-A5", tasks)).toBe("i28-A5");
  expect(nodeTask(f, "i28-A8", tasks)).toBeNull();
  expect(nodeTask(f, "i28-A5", tasks, true)).toBeNull();
  expect(nodeTask(f, "i28-A5", [])).toBeNull();
  expect(nodeTask(undefined, "i28-A5", tasks)).toBeNull();
  f.nodes.find(n => n.key === "i28-A5")!.missing = true;
  expect(nodeTask(f, "i28-A5", tasks)).toBeNull();
});
