# 台账同步第4轮验证证据

复现测试：marker-bootstrap、hlc-edge、hlc-function-causality、bootstrap-restore。
纯合成契约状态机，不是尚未实现的同步代码测试。marker/库/升级 journal 是不同的内存对象；
HLC 经同一个 receive/send 候选算法及延期队列计算，输出不由手写预期时间赋值。

```python
import argparse, json, re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--expect', choices=['baseline', 'revised'], required=True)
parser.add_argument('--design', default='docs/design/ledger-sync.md')
args = parser.parse_args()
doc = Path(args.design).read_text()
policy = json.loads(re.search(r'```json ledger-sync-safety-v1\n(.*?)\n```', doc, re.S).group(1))

class Bootstrap:
    def __init__(self, inventory, markers=None):
        self.inventory, self.markers = inventory, dict(markers or {})
        self.prepared, self.complete = False, False
        self.ever_center = {name: registration != 'never-shared' or self.markers.get(name) == 'center'
                            for name, registration in inventory.items()}
        self.database = {name: {'stage': 'review'} for name in inventory}
    def preflight(self, stop_after=None):
        if self.complete or not policy.get('bootstrapExistingLocal'):
            return
        self.prepared = True
        for i, (name, registration) in enumerate(self.inventory.items()):
            if name not in self.markers:
                self.markers[name] = 'local' if registration == 'never-shared' else 'unknown'
            if stop_after == i:
                return
        self.complete = True
    def stage(self, name, target):
        if not self.complete or self.markers.get(name) != 'local':
            return 'denied'
        self.database[name]['stage'] = target
        return 'local-accepted'
    def adopt(self, name):
        if not self.complete:
            return 'not-ready'
        self.ever_center[name] = True
        self.markers[name] = 'center'
        return 'adopted'
    def recover_local(self, name):
        if not self.complete or self.ever_center.get(name) is not False:
            return 'denied'
        self.markers[name] = 'local'
        return 'recovered'
    def restore_old_database(self):
        self.database = {name: {'stage': 'review', 'authority': 'local'} for name in self.inventory}

class Clock:
    def __init__(self, now=1000):
        self.now, self.value, self.pending = now, (now, 0), None
        self.materialized, self.issued, self.ignore_remote = [], [], False
    def limit(self):
        return min(self.now + policy['maxFutureMs'], (1 << 48) - 1 - policy['physicalReserveMs'])
    def candidate(self, remote=None):
        local_p, local_l = self.value
        remote_p, remote_l = remote if remote is not None else (0, 0)
        if self.ignore_remote:
            remote_p, remote_l = 0, 0
        physical = max(local_p, remote_p, self.now)
        if remote is not None and physical == local_p == remote_p:
            logical = max(local_l, remote_l) + 1
        elif physical == local_p:
            logical = local_l + 1
        elif remote is not None and physical == remote_p:
            logical = remote_l + 1
        else:
            logical = 0
        physical += logical // 65536
        return physical, logical % 65536
    def apply(self, remote=None):
        candidate = self.candidate(remote)
        hard_cap = (1 << 48) - 1 - policy['physicalReserveMs']
        if candidate[0] > hard_cap:
            self.pending = None
            return 'exhausted'
        if candidate[0] > self.limit():
            if policy.get('hlcBoundaryAction') == 'defer':
                self.pending = ('receive', remote) if remote is not None else ('send', None)
                return 'pending'
            return 'rejected'
        self.value = candidate
        if remote is None:
            self.issued.append(candidate)
        else:
            self.materialized.append(remote)
        self.pending = None
        return 'accepted'
    def receive(self, remote):
        if remote[0] > self.limit():
            return 'quarantined'
        return self.apply(remote)
    def send(self):
        if self.pending:
            return 'pending'
        return self.apply()
    def tick_and_retry(self, elapsed):
        self.now += elapsed
        if self.pending:
            kind, remote = self.pending
            return self.apply(remote if kind == 'receive' else None)
        return 'idle'

def bootstrap_probe():
    upgrade = Bootstrap({'local-project': 'never-shared', 'shared-project': 'shared'}, {'shared-project': 'center'})
    upgrade.preflight()
    first = upgrade.stage('local-project', 'build')
    upgrade.restore_old_database()
    shared = upgrade.stage('shared-project', 'merge')
    upgrade.markers.pop('local-project', None)
    upgrade.preflight()  # A completed preflight cannot recreate missing markers.
    missing = upgrade.stage('local-project', 'merge')
    if policy.get('bootstrapExistingLocal'):
        assert upgrade.recover_local('local-project') == 'recovered'
        assert upgrade.adopt('local-project') == 'adopted'
        upgrade.markers.pop('local-project')
        upgrade.restore_old_database()
        assert upgrade.recover_local('local-project') == 'denied'
        assert upgrade.stage('local-project', 'merge') == 'denied'
    return first == 'local-accepted' and shared == 'denied' and missing == 'denied'

def restore_probe():
    upgrade = Bootstrap({'L': 'never-shared', 'C': 'shared'}, {'C': 'center'})
    upgrade.preflight(stop_after=0)
    mid = upgrade.stage('L', 'build')
    upgrade.preflight()
    upgrade.restore_old_database()
    return mid == 'denied' and upgrade.stage('L', 'build') == 'local-accepted' and upgrade.stage('C', 'merge') == 'denied'

def edge_probe():
    receiver = Clock()
    remote = (receiver.limit(), 65535)
    held = receiver.receive(remote)
    no_effect = receiver.value == (1000, 0) and not receiver.materialized and not receiver.issued
    retried = receiver.tick_and_retry(1)
    sent = receiver.send()
    receive_ok = held == 'pending' and no_effect and retried == 'accepted' and sent == 'accepted' and receiver.value > remote
    sender = Clock()
    sender.value = (sender.limit(), 65535)  # Valid prior state; send must defer rather than reject.
    delayed = sender.send()
    resumed = sender.tick_and_retry(1)
    send_ok = delayed == 'pending' and resumed == 'accepted' and len(sender.issued) == 1
    return receive_ok and send_ok

def causal_probe(mutated=False):
    clock = Clock()
    clock.ignore_remote = mutated
    remote = (clock.now + 30000, 65535)
    received = clock.receive(remote)
    after_receive = clock.value
    sent = clock.send()
    return received == sent == 'accepted' and after_receive > remote and clock.value > after_receive

def hardcap_probe():
    hard_cap = (1 << 48) - 1 - policy['physicalReserveMs']
    clock = Clock(now=hard_cap)
    clock.value = (hard_cap, 65535)
    return clock.send() == 'exhausted' and not clock.issued and clock.pending is None

results = {'hlc-hardcap': hardcap_probe(), 'marker-bootstrap': bootstrap_probe(), 'hlc-edge': edge_probe(),
           'hlc-function-causality': causal_probe(), 'bootstrap-restore': restore_probe()}
for name, ok in results.items():
    print(name + ': ' + ('GREEN' if ok else 'RED'))
    expected = args.expect == 'revised' or name in ['hlc-function-causality', 'hlc-hardcap']
    assert ok == expected, name
assert not causal_probe(mutated=True)
print('hlc-function-causality: IGNORE REMOTE MUTATION RED')
```

## 确切复跑结果

同一最终脚本读取基准 `740e748608581cdf035c3474ab276d5e58aedf68` 的设计稿并传 `--expect baseline`：

```text
hlc-hardcap: GREEN
marker-bootstrap: RED
hlc-edge: RED
hlc-function-causality: GREEN
bootstrap-restore: RED
hlc-function-causality: IGNORE REMOTE MUTATION RED
```

读取修订稿并传 `--expect revised`：

```text
hlc-hardcap: GREEN
marker-bootstrap: GREEN
hlc-edge: GREEN
hlc-function-causality: GREEN
bootstrap-restore: GREEN
hlc-function-causality: IGNORE REMOTE MUTATION RED
```

两次退出 0，各自按声明的预期断言；旧红在修改设计前也已确认。标准 HLC 因果与硬耗尽旧契约本来正确，未造假旧失败。
模型验证 preflight 清单/完成顺序，不证明生产项目登记识别、原子文件写/升级锁已经实现；这些必须由 SY7 实际测试。
HLC 模型测试候选、接收延期、发送延期、可信时间推进后重试与忽略 remote 突变，不涉及真实网络/定时器或可信锚实现。
六入口 Bun build 均退出 0；节点 glob 实跑 10 节点/171 对/overlaps=none，非 SY7 现有匹配文件数 0。

基准 sandbox 单独复核：隔离 clone 在基准 740e7486 上 frozen install 退出 0；
`tests/sandbox-isolation.test.ts`：5 pass / 1 fail，109 expect()、66.88 秒，退出 1，同一重启临时端口占用断言。
额外验证 local 明确身份恢复可行，但 adopt 设置单调 everCenter 后，删 marker/恢复旧库也不能用该恢复命令降回 local。

## strict 全量检查最终结果

`GUARD_STRICT=1 bun run check`：typecheck 通过；11771 pass / 20 skip / 1 fail，
945 文件、213528 expect()、4 snapshots、605.40 秒，check 退出 1，组合命令未继续执行 guard。
唯一失败 `tests/sandbox-isolation.test.ts`：restart 第二次 up 临时端口占用，用例耗时 61344.98ms；
基准同文件同断言复现（66.88 秒）。没有其他等待型超时失败，不声称该端口错误得到豁免。
另跑严格 guard 退出 0；六入口 build、节点 glob、diff --check 通过。
原始日志为临时目录中的 `i28-sync1-r4-check.log`、`i28-sync1-r4-base-sandbox.log`；
PR head CI 必过项仍由 PM/合并闸核对。无 disputes，未改运行代码、生产台账或凭据，未合并/部署/发布。
