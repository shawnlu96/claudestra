# 共享台账 V2 · 阶段二设计的核对脚本

[shared-ledger-v2-stage2-plan.md](shared-ledger-v2-stage2-plan.md)（下称「设计稿」）的附属文件，只放核对命令；结论与实测输出在设计稿 §4、§8。

## 1. fileGlobs / 热点例外 / 依赖核对（设计稿 §4）

在仓库根执行。脚本解析设计稿附录每个节点的「deps / 估时」行与「范围」列表，规则见设计稿 §4。

```sh
bun run - <<'JS'
import { readFileSync } from 'node:fs';
const doc = readFileSync('docs/design/shared-ledger-v2-stage2-plan.md', 'utf8').split('\n## 附录')[1];
const parts = doc.split(/\n### ([A-Z0-9]+) · /), nodes = new Map();
for (let i = 1; i < parts.length; i += 2) {
  const body = parts[i + 1], scope = body.split('**范围**')[1].split('**验收线**')[0];
  const m = body.match(/deps：([^；]+)；估时：([\d.]+) 小时/);
  nodes.set(parts[i], { deps: m[1] === '无' ? [] : m[1].split('、'), hours: Number(m[2]),
    paths: [...scope.matchAll(/^- `([^`]+)`$/gm)].map(x => x[1]),
    exceptions: [...scope.matchAll(/^- 例外 `([^`]+)`/gm)].map(x => x[1]) });
}
const files = new TextDecoder().decode(Bun.spawnSync(['git', 'ls-files', '-z']).stdout).split('\0').filter(Boolean);
const sp = p => p.endsWith('/**') ? [p.slice(0, -2), ''] : p.split('*');
function symbolic(a, b) {
  if (!a.includes('*')) return new Bun.Glob(b).match(a);
  if (!b.includes('*')) return new Bun.Glob(a).match(b);
  if (sp(a).length !== 2 || sp(b).length !== 2) throw Error('glob syntax ' + a + ' ' + b);
  const [ap, as] = sp(a), [bp, bs] = sp(b);
  return (ap.startsWith(bp) || bp.startsWith(ap)) && (as.endsWith(bs) || bs.endsWith(as));
}
const expand = n => files.filter(f => n.paths.some(p => new Bun.Glob(p).match(f)));
const keys = [...nodes.keys()], rows = [];
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
  const a = nodes.get(keys[i]), b = nodes.get(keys[j]), eb = expand(b);
  const hit = expand(a).filter(f => eb.includes(f)).length;
  const planned = a.paths.filter(x => b.paths.some(y => symbolic(x, y))).length;
  if (hit || planned) throw Error(keys[i] + '/' + keys[j] + ' overlap ' + hit + '/' + planned);
  rows.push(keys[i], keys[j]);
}
const HOT = ['src/bridge.ts', 'src/scheduler.ts', 'src/manager/ledger.ts', 'src/lib/scheduler-pass.ts',
  'src/lib/scheduler-auto-tick.ts', 'src/lib/scheduler-merge-driver.ts', 'web/features/collab/collab-view.tsx',
  'src/lib/ledger-write.ts', 'src/bridge/local-api/index.ts', 'src/lib/scheduler-auto-deps.ts', 'src/bridge/asks.ts',
  'src/bridge/ask-entry.ts', 'src/bridge/order-tools.ts', 'src/lib/scheduler-merge-external.ts', 'tests/ledger-migrate.test.ts'];
const globs = [...nodes.values()].flatMap(n => n.paths), owners = new Map();
for (const h of HOT) if (globs.some(g => new Bun.Glob(g).match(h))) throw Error('hot file in fileGlobs ' + h);
for (const [k, n] of nodes) for (const e of n.exceptions) {
  if (owners.has(e) || !HOT.includes(e) || !files.includes(e)) throw Error('bad exception ' + k + ' ' + e);
  owners.set(e, k);
}
const seen = new Set(), visiting = new Set();
const visit = k => { if (seen.has(k) || !nodes.has(k)) return; if (visiting.has(k)) throw Error('cycle ' + k);
  visiting.add(k); nodes.get(k).deps.forEach(visit); visiting.delete(k); seen.add(k); };
keys.forEach(visit);
for (const [k, n] of nodes) if (!(n.hours <= 2) || !n.paths.length) throw Error('hours/globs ' + k);
const external = [...new Set([...nodes.values()].flatMap(n => n.deps).filter(d => !nodes.has(d)))];
const first = keys.filter(k => nodes.get(k).deps.length === 0);
console.log('nodes=' + keys.length + ' pairs=' + rows.length / 2 + ' (all existing/planned 0/0) hours=' + keys.reduce((s, k) => s + nodes.get(k).hours, 0));
console.log('hot exceptions=' + [...owners].map(([f, k]) => k + ':' + f).join(', '));
console.log('unclaimed hot=' + HOT.filter(h => !owners.has(h)).join(', '));
console.log('acyclic=yes external deps=' + external.join(','));
console.log('first wave=' + first.length + ' ' + first.join(','));
console.log('per node tracked/globs/exceptions: ' + keys.map(k => k + ' ' + expand(nodes.get(k)).length + '/' + nodes.get(k).paths.length
  + '/' + nodes.get(k).exceptions.length).join(', '));
JS
```

## 2. 公开内容自检（设计稿 §8）

除本命令自身所在行外应无命中；其余命中须人工复核。

```sh
git grep -nEI '([0-9]{1,3}\.){3}[0-9]{1,3}|https?://|services/|vendor/|Bearer[[:space:]]|BEGIN.*PRIVATE KEY|\.local\b' \
  -- 'docs/design/shared-ledger-v2-stage2*.md'
```
