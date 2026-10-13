/** team-project-TEAMSCRUB: the running receipt names the deploy job by a short form the team body upload does not mask. */
import { expect, test } from "bun:test";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import { DEPLOY_LABEL_PREFIX, getDeployRun } from "../src/lib/scheduler-deploy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { scrubTeamBody } from "../src/lib/team-body-scrub.js";
import { teamBodySourceText } from "../src/lib/team-body-text.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";
import { SCRUB } from "./shared-ledger-mirror-fixture.test.js";

const LABEL = `${DEPLOY_LABEL_PREFIX}0123456789abcdef0123456789abcdef`;
const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true,
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo", deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } };

test("[验收线 3] the running event reads deploy.<last 8>; the full label stays in event data and on the deploy run", async () => {
  const f = mergedCard();
  try {
    let view: Awaited<ReturnType<DeployJobs["observe"]>> = null;
    const jobs: DeployJobs = { label: () => LABEL, observe: async () => view, remove: async () => true,
      submit: async () => { view = { label: LABEL, liveness: "alive", result: null, deadline: 10_000 }; return LABEL; } };
    await deployTick(f.db, config, { manager: ledgerAs(f.db, "scheduler", () => 1000), jobs, assertActive: () => {}, now: () => 1000 });
    expect(getDeployRun(f.db, f.intent)).toMatchObject({ phase: "running", label: LABEL });
    const events = f.db.query("SELECT text, data FROM events WHERE target = 'T9' AND kind = 'scheduler' ORDER BY seq").all() as { text: string; data: string }[];
    const running = events.find((e) => JSON.parse(e.data).op === "deploy_phase" && JSON.parse(e.data).to === "running")!;
    expect(running.text).toBe("自动部署：running（提交部署任务 deploy.89abcdef）");
    expect(running.text).not.toMatch(/[0-9a-f]{32}/i);
    expect(JSON.parse(running.data)).toMatchObject({ label: LABEL, receipt: "提交部署任务 deploy.89abcdef" });
    // An event written before the change goes up in the same form, and neither is masked.
    expect(teamBodySourceText("event", `自动部署：running（提交部署任务 ${LABEL}）`)).toBe(running.text);
    expect(scrubTeamBody(running.text, SCRUB)).toMatchObject({ text: running.text, maskedSegments: 0, refused: false });
  } finally { f.close(); }
});
