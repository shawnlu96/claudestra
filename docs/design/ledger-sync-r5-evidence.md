# 台账同步第5轮验证证据

复现测试：bootstrap-rerun、local-disaster-recovery、replica-bound-skew。
范围仅设计文件；以下是契约状态机，不是生产同步实现。复用 r4 的 Bootstrap/HLC 算法，
新增原安装升级会话、丢失全部库外状态、新身份恢复与 admission 时间界路径。
新身份 fork 的身份/动作集合仅是合成夹具；真实随机身份、白名单导入、owner 确认和握手验证由 SY7 测试。

修改设计前，直接跑 r4 模型的审查反例，`assert b.stage('P','merge') == 'denied'` 退出 1：
`AssertionError: bootstrap-rerun: stale backup regrants local authority`。

```python
import argparse, json, re
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--design', default='docs/design/ledger-sync.md')
parser.add_argument('--expect', choices=['red', 'green'], required=True)
args = parser.parse_args()
policy = json.loads(re.search(r'```json ledger-sync-safety-v1\n(.*?)\n```', Path(args.design).read_text(), re.S).group(1))
r4 = Path('docs/design/ledger-sync-r4-evidence.md').read_text().split('```python\n')[1].split('\n```')[0]
# Reuse preceding candidate/receive/send implementation, not precomputed HLC results.
namespace = {'policy': policy}
exec(r4[r4.index('class Bootstrap:'):r4.index('def bootstrap_probe():')], namespace)
OldBootstrap, Clock = namespace['Bootstrap'], namespace['Clock']

class Installation(OldBootstrap):
    def __init__(self, inventory, original_upgrade=False):
        super().__init__(inventory)
        self.upgrade_session = original_upgrade
        self.project_id = 'original-project'
        self.actions = ['old-deploy']
        self.authorizations = ['old-grant']
    def preflight(self, stop_after=None):
        if policy.get('bootstrapRequiresLiveUpgrade') and not (self.upgrade_session or self.prepared):
            return
        super().preflight(stop_after)
        if self.complete:
            self.upgrade_session = False
    def fork_new_project(self):
        if policy.get('lostInstallationRecovery') != 'new-identity-merge-only':
            return None
        fork = Installation({'new-project': 'never-shared'}, original_upgrade=True)
        fork.project_id = 'fresh-project'
        fork.actions, fork.authorizations = [], []
        fork.preflight()
        return fork

def bootstrap_rerun():
    a = Installation({'P': 'never-shared'}, original_upgrade=True)
    a.preflight(); assert a.adopt('P') == 'adopted'
    # Old backup contains the pre-adoption inventory, no installation journal/session.
    b = Installation({'P': 'never-shared'})
    b.preflight()
    return b.stage('P', 'merge') == 'denied' and not b.complete

def local_disaster_recovery():
    original = Installation({'L': 'never-shared'}, original_upgrade=True)
    original.preflight(stop_after=0)
    assert original.stage('L', 'build') == 'denied'
    original.preflight()
    assert original.stage('L', 'build') == 'local-accepted'
    original.markers.clear()
    assert original.recover_local('L') == 'recovered'
    lost = Installation({'L': 'never-shared'})
    lost.preflight()
    fork = lost.fork_new_project()
    return (lost.stage('L', 'merge') == 'denied' and fork is not None
            and fork.project_id != lost.project_id and not fork.actions and not fork.authorizations
            and fork.stage('new-project', 'build') == 'local-accepted')

def replica_bound_skew(mutated=False):
    clock = Clock(now=1000)
    center_now, remote = 31000, (90000, 2)
    # Fixture represents already authenticated transport and bound dot/digest/epoch.
    def receive_admitted(value, authenticated):
        if not authenticated:
            return 'quarantined'
        bound_now = center_now if policy.get('replicaAdmissionBound') == 'authenticated-centerNow' and not mutated else clock.now
        bound = min(bound_now + policy['maxFutureMs'], (1 << 48) - 1 - policy['physicalReserveMs'])
        if value[0] > bound:
            return 'quarantined'
        return clock.apply(value)
    assert receive_admitted(remote, False) == 'quarantined'
    assert receive_admitted((center_now + 60001, 0), True) == 'quarantined'
    result = receive_admitted(remote, True)
    no_effect = not clock.materialized and clock.value == (1000, 0)
    retry = clock.tick_and_retry(30000)
    return result == 'pending' and no_effect and retry == 'accepted' and clock.value > remote

results = {'bootstrap-rerun': bootstrap_rerun(), 'local-disaster-recovery': local_disaster_recovery(),
           'replica-bound-skew': replica_bound_skew()}
for name, ok in results.items():
    print(name + ': ' + ('GREEN' if ok else 'RED'))
    assert ok == (args.expect == 'green'), name
assert not replica_bound_skew(mutated=True)
print('replica-bound-skew: LOCAL-TIME MUTATION RED')
```

## 先红后绿

脚本读基准 `632605640c424d65eb82b6303f3b7b78a73b80f0` 设计，`--expect red`：

```text
bootstrap-rerun: RED
local-disaster-recovery: RED
replica-bound-skew: RED
replica-bound-skew: LOCAL-TIME MUTATION RED
```

同一脚本读修订稿，`--expect green`：

```text
bootstrap-rerun: GREEN
local-disaster-recovery: GREEN
replica-bound-skew: GREEN
replica-bound-skew: LOCAL-TIME MUTATION RED
```

两次均退出 0，断言各自红/绿预期；把 admission 校验突变为本机时间时仍红。
首次升级、prepared 崩溃续作与 marker 丢失恢复也实跑，不靠手写 HLC 结果。
无法从可回滚旧备份证明原身份之后未采用 center；全丢情况下明确牺牲同身份离线无损恢复，
提供新身份仅恢复 merge 资料的出口，保留原项目拒执行，不复活旧授权或部署动作。

## 交付检查

- frozen install 退出 0；六入口（bridge/channel-server/manager/launcher/cron/setup）build 全部退出 0。
- `GUARD_STRICT=1 bun run check`：typecheck 通过，11771 pass / 20 skip / 1 fail，945 文件，213542 expect()，891 秒；退出 1。
- 唯一失败为 `tests/sandbox-codex-home.test.ts` 的双 rollout 归档用例，5005ms 超过默认 5000ms；head 单跑 8 pass / 0 fail（4.35 秒）。
- 隔离基准 clone 在 `632605640c424d65eb82b6303f3b7b78a73b80f0` frozen install 通过；同文件两次单跑均 8 pass / 0 fail（3.53/3.70 秒）。
  基准全量探查出现其他等待超时/随机失败，已停止探查；没有复现 head 的同一归档超时，因此**不声明获得基准同错豁免**。
  不把 targeted 通过等同全量通过；最终全量必过项由 PR head CI 和合并闸核对。
- 单独严格 guard 通过；glob 脚本：10 SY 节点、171 对、overlaps=none、非 SY7 已有匹配 0；diff whitespace 通过。
- 无 disputes；P1 bootstrap-rerun 与 P2 replica-bound-skew 均修订契约并有红绿模型。未改运行代码、guard baseline 或生产资源。

原始检查日志保留于临时目录的 `i28-r5-check.log`、`i28-r5-final-guard.log`、
`i28-r5-head-targeted.log`、`i28-r5-base-test.log`、`i28-r5-base-targeted-2.log`、`i28-r5-base-all.log`。
