"""Compare actual inventories and simulate context propagation without generation."""
import argparse
from array import array
from collections import Counter, deque
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb
from globalGraphDependencyLevels import csr, components


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    summary = json.loads((args.report/'summary.json').read_text(encoding='utf-8'))
    spill = TemporaryDirectory(prefix='annotation-owner-chains-')
    db = duckdb.connect(config={'temp_directory': spill.name})
    db.execute("SET memory_limit='1GB'")
    db.execute('SET threads=1')
    db.execute('SET preserve_insertion_order=false')
    for name, file in [('plan', args.report/'annotation-plan.parquet'),
                       ('subjects', args.report/'subjects.parquet'),
                       ('old_plan', args.baseline/'annotation-plan.parquet'),
                       ('old_subjects', args.baseline/'subjects.parquet'),
                       ('nodes', Path(summary['input'])/'nodes.parquet')]:
        db.read_parquet(str(file)).create_view(name)
    db.execute('''CREATE TABLE numbered AS SELECT
        (row_number() OVER (ORDER BY stable_id)-1)::INTEGER AS idx,
        p.*,list_contains(s.labels,'SourceFile') AS file_boundary
        FROM plan p JOIN subjects s USING(stable_id)''')
    count = db.execute('SELECT count(*) FROM numbered').fetchone()[0]
    assert count == summary['nodes']
    ids = []
    decisions = []
    boundaries = bytearray()
    for stable_id, decision, boundary in db.execute(
            'SELECT stable_id,decision,file_boundary FROM numbered ORDER BY idx').fetchall():
        ids.append(stable_id)
        decisions.append(decision)
        boundaries.append(bool(boundary))
    index = {stable_id: i for i, stable_id in enumerate(ids)}
    owner = array('i', [-1]) * count
    for child, target in db.execute('''SELECT idx,context_targets[1] FROM numbered
        WHERE decision IN ('compose-in-owner','follow-original') AND len(context_targets)=1''').fetchall():
        owner[child] = index.get(target, -1)
    terminal = {'generation-candidate', 'contract-candidate', 'external-boundary', 'syntax-summary'}
    cache = {}

    def walk(start):
        trail = []
        seen = set()
        current = start
        while current not in cache:
            if current in seen:
                result = ('cycle', current, 0)
                break
            if boundaries[current] or decisions[current] in terminal:
                result = ('source-file' if boundaries[current] else decisions[current], current, 0)
                cache[current] = result
                break
            if owner[current] < 0:
                result = (decisions[current], current, 0)
                cache[current] = result
                break
            seen.add(current)
            trail.append(current)
            current = owner[current]
        else:
            result = cache[current]
        for child in reversed(trail):
            result = (result[0], result[1], result[2]+1)
            cache[child] = result
        return cache.get(start, result)

    cases = db.execute('''SELECT s.stable_id,s.declaration_kind,p.decision
        FROM old_subjects s JOIN old_plan p USING(stable_id)
        WHERE p.decision='review-owner' AND s.reason='owned-value-declaration'
        ORDER BY s.stable_id''').fetchall()
    changes = Counter()
    endings = Counter()
    evidence = []
    for stable_id, kind, old_decision in cases:
        current = index.get(stable_id)
        if current is None:
            changes[(kind, 'absent-in-new-snapshot')] += 1
            evidence.append((stable_id, kind, 'absent-in-new-snapshot', None, None, 0))
            continue
        status, end, hops = walk(current)
        changes[(kind, decisions[current])] += 1
        endings[(kind, status)] += 1
        evidence.append((stable_id, kind, decisions[current], status, ids[end], hops))
    db.execute('CREATE TABLE comparison(stable_id VARCHAR,kind VARCHAR,decision VARCHAR,terminal_status VARCHAR,terminal_id VARCHAR,hops INTEGER)')
    if evidence:
        db.executemany('INSERT INTO comparison VALUES (?,?,?,?,?,?)', evidence)
    destination = (args.output/'declaration-chains.parquet').as_posix().replace("'", "''")
    db.execute(f"COPY comparison TO '{destination}' (FORMAT PARQUET,COMPRESSION ZSTD)")

    # Owners require their composed children's context. References require their
    # originals. Required bodies are prerequisites, not ownership arrows.
    db.execute('''CREATE TABLE dependency_ids AS
        SELECT target AS consumer,stable_id AS prerequisite FROM plan,unnest(context_targets) t(target)
          WHERE decision='compose-in-owner'
        UNION
        SELECT stable_id,target FROM plan,unnest(context_targets) t(target)
          WHERE decision='follow-original'
        UNION
        SELECT stable_id,target FROM plan,unnest(required_body_context) t(target)''')
    if any(row[0]=='required_type_context' for row in db.execute('DESCRIBE plan').fetchall()):
        db.execute('''INSERT INTO dependency_ids
            SELECT stable_id,target FROM plan,unnest(required_type_context) t(target)
            EXCEPT SELECT consumer,prerequisite FROM dependency_ids''')
    if any(row[0]=='required_value_context' for row in db.execute('DESCRIBE plan').fetchall()):
        db.execute('''INSERT INTO dependency_ids
            SELECT stable_id,target FROM plan,unnest(required_value_context) t(target)
            EXCEPT SELECT consumer,prerequisite FROM dependency_ids''')
    if any(row[0]=='required_callable_context' for row in db.execute('DESCRIBE plan').fetchall()):
        db.execute('''INSERT INTO dependency_ids
            SELECT stable_id,target FROM plan,unnest(required_callable_context) t(target)
            EXCEPT SELECT consumer,prerequisite FROM dependency_ids''')
    missing = db.execute('''SELECT count(*) FROM dependency_ids d
        LEFT JOIN numbered a ON a.stable_id=d.consumer
        LEFT JOIN numbered b ON b.stable_id=d.prerequisite WHERE a.idx IS NULL OR b.idx IS NULL''').fetchone()[0]
    assert missing == 0, f'Missing dependency endpoints: {missing}'
    sources, targets = array('I'), array('I')
    cursor = db.execute('''SELECT a.idx,b.idx FROM dependency_ids d
        JOIN numbered a ON a.stable_id=d.consumer JOIN numbered b ON b.stable_id=d.prerequisite''')
    while batch := cursor.fetchmany(100000):
        for a, b in batch:
            sources.append(a)
            targets.append(b)
    group, sizes = components(count, csr(count, sources, targets), csr(count, targets, sources))
    remaining = array('I', [0]) * len(sizes)
    levels = array('I', [0]) * len(sizes)
    blocked = bytearray(len(sizes))
    direct = bytearray(count)
    cyclic = bytearray(size > 1 for size in sizes)
    for i, decision in enumerate(decisions):
        if not boundaries[i] and (decision.startswith('blocked-') or decision.startswith('review-')
                or decision.startswith('deferred-')):
            direct[i] = 1
            blocked[group[i]] = 1
    component_sources, component_targets = array('I'), array('I')
    for a, b in zip(sources, targets):
        parent, child = group[a], group[b]
        if a == b:
            cyclic[parent] = 1
        if parent != child:
            component_sources.append(parent)
            component_targets.append(child)
            remaining[parent] += 1
    waits_on_cycle = bytearray(cyclic)
    offsets, neighbors = csr(len(sizes), component_targets, component_sources)
    queue = deque(i for i, degree in enumerate(remaining) if degree == 0)
    processed = 0
    while queue:
        child = queue.popleft()
        processed += 1
        for pos in range(offsets[child], offsets[child+1]):
            parent = neighbors[pos]
            blocked[parent] |= blocked[child]
            waits_on_cycle[parent] |= waits_on_cycle[child]
            levels[parent] = max(levels[parent], levels[child]+1)
            remaining[parent] -= 1
            if remaining[parent] == 0:
                queue.append(parent)
    assert processed == len(sizes)
    assert all(group[a] == group[b] or levels[group[a]] > levels[group[b]]
               for a, b in zip(sources, targets))
    states = Counter('blocked-evidence' if blocked[group[i]] else
                     'requires-cyclic-context' if waits_on_cycle[group[i]] else
                     'structurally-traversable' for i in range(count))
    direct_count = sum(direct)
    inherited = Counter(decisions[i] for i in range(count)
                        if blocked[group[i]] and not direct[i])
    assert direct_count + sum(inherited.values()) == states['blocked-evidence']
    direct_reasons = db.execute('''SELECT decision,evidence_reason,owner_status,count(*)
        FROM numbered WHERE NOT file_boundary
          AND (starts_with(decision,'blocked-') OR starts_with(decision,'review-')
               OR starts_with(decision,'deferred-'))
        GROUP BY ALL ORDER BY count(*) DESC''').fetchall()
    examples = db.execute('''SELECT n.stable_id,n.decision,n.evidence_reason,n.owner_status,
        count(d.consumer) AS immediate_consumers
        FROM numbered n LEFT JOIN dependency_ids d ON d.prerequisite=n.stable_id
        WHERE NOT n.file_boundary
          AND (starts_with(n.decision,'blocked-') OR starts_with(n.decision,'review-')
               OR starts_with(n.decision,'deferred-'))
        GROUP BY ALL ORDER BY immediate_consumers DESC,n.stable_id LIMIT 20''').fetchall()
    failures = db.execute('''SELECT kind,terminal_status,terminal_id,count(*) AS total
        FROM comparison WHERE terminal_status NOT IN ('source-file','generation-candidate',
        'contract-candidate','external-boundary','syntax-summary')
        GROUP BY ALL ORDER BY total DESC LIMIT 20''').fetchall()
    result = {'version': 2, 'baseline': str(args.baseline), 'input': str(args.report),
        'baselineReviewDeclarations': len(cases),
        'decisions': [{'kind': k, 'decision': d, 'count': c} for (k,d),c in sorted(changes.items())],
        'ownerChainTerminals': [{'kind': k, 'status': s, 'count': c} for (k,s),c in sorted(endings.items())],
        'remainingStops': [{'kind': k, 'status': s, 'stableId': i, 'count': c} for k,s,i,c in failures],
        'bottomUp': {'nodes': count, 'dependencies': len(sources), 'missingEndpoints': missing,
            'components': len(sizes), 'cyclicComponents': sum(cyclic),
            'processedComponents': processed, 'maximumComponentLevel': max(levels),
            'states': dict(states),
            'unconfirmedReadiness': {
                'directNodes': direct_count,
                'inheritedOnlyNodes': sum(inherited.values()),
                'inheritedByDecision': dict(inherited),
                'directReasons': [{'decision': d, 'reason': r, 'ownerStatus': o, 'count': c}
                                  for d,r,o,c in direct_reasons],
                'directExamples': [{'stableId': i, 'decision': d, 'reason': r,
                                    'ownerStatus': o, 'immediateConsumers': c}
                                   for i,d,r,o,c in examples],
                'policy': 'Direct means own unresolved/review evidence or pending source expansion; inherited-only means a blocked prerequisite. Neither counts independent extraction defects.'}},
        'generatesAnnotations': False, 'writesGraph': False,
        'limitations': ['Simulates the inventory plan, not all production annotation-profile dependencies.',
            'SourceFile is an ownership boundary, not a certified annotation job.',
            'Cyclic components need joint context; no arbitrary member is selected first.']}
    (args.output/'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))
    db.close()
    spill.cleanup()


if __name__ == '__main__':
    main()
