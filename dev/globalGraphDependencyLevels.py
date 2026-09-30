"""Read-only global dependency inventory, not annotation-profile certification."""
import argparse
from array import array
from collections import Counter, deque
import hashlib
import json
from pathlib import Path
import time

import duckdb
import pyarrow as pa


# Arrows below mean consumer -> prerequisite. Unknown edge kinds are reported,
# never silently interpreted as dependencies or evidence of readiness.
FORWARD = {
    "VALUE_FROM", "READS_FROM", "RESOLVES_TO", "RESOLVES_TO_MEMBER",
    "USES_REFERENCE", "USES_MEMBER_REFERENCE", "ALIASES", "DERIVES_FROM",
    "CALLS", "CALLS_VALUE", "INVOKES", "HAS_ARGUMENT", "HAS_PROPERTY",
    "HAS_OPERATION", "HAS_FLOW_BLOCK", "HAS_PARAMETER", "HAS_MEMBER",
    "RETURNS_VALUE", "SPREADS_FROM", "TYPED_AS", "TYPE_ARGUMENT",
    "COMPOSES_SYNTAX", "SIGNATURE_PARAMETER", "SIGNATURE_RETURN",
    "RETURN_TYPE_ARGUMENT", "USES_LITERAL", "REEXPORTS", "EXTENDS",
}
REVERSE = {"BINDS_TO_PARAMETER", "NESTED_IN"}
IGNORED = {
    "NEXT", "TRUE", "FALSE", "REPEATS", "REJOINS", "XOR_JOIN",
    "BODY_ENTRY", "ENCLOSED_BY", "AST_CHILD", "ArgJoin", "FieldJoin",
}


def csr(n, sources, targets):
    offsets = array("I", [0]) * (n + 1)
    for source in sources:
        offsets[source + 1] += 1
    for i in range(n):
        offsets[i + 1] += offsets[i]
    positions = array("I", offsets)
    neighbors = array("I", [0]) * len(targets)
    for source, target in zip(sources, targets):
        neighbors[positions[source]] = target
        positions[source] += 1
    return offsets, neighbors


def components(n, outgoing, incoming):
    """Iterative Kosaraju: bounded stacks, including very deep real graphs."""
    offsets, neighbors = outgoing
    seen = bytearray(n)
    order = array("I")
    for root in range(n):
        if seen[root]:
            continue
        seen[root] = 1
        stack = [(root, offsets[root])]
        while stack:
            node, cursor = stack[-1]
            if cursor == offsets[node + 1]:
                order.append(node)
                stack.pop()
                continue
            stack[-1] = (node, cursor + 1)
            child = neighbors[cursor]
            if not seen[child]:
                seen[child] = 1
                stack.append((child, offsets[child]))
    offsets, neighbors = incoming
    group = array("i", [-1]) * n
    sizes = []
    for root in reversed(order):
        if group[root] >= 0:
            continue
        key = len(sizes)
        group[root] = key
        stack = [root]
        size = 0
        while stack:
            node = stack.pop()
            size += 1
            for pos in range(offsets[node], offsets[node + 1]):
                child = neighbors[pos]
                if group[child] < 0:
                    group[child] = key
                    stack.append(child)
        sizes.append(size)
    return group, sizes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    db = duckdb.connect()
    db.execute("SET memory_limit='1GB'")
    db.execute("SET threads=2")
    db.read_parquet(str(args.parquet / "nodes.parquet")).create_view("nodes")
    db.read_parquet(str(args.parquet / "relationships.parquet")).create_view("rels")
    db.execute("""CREATE TABLE numbered AS SELECT
        (row_number() OVER (ORDER BY stable_id)-1)::INTEGER AS idx,
        stable_id, labels,
        json_extract_string(props_json, '$.parentStepStableId') AS step_id,
        coalesce(json_extract_string(props_json, '$.parentFlowBlockStableId'),
                 json_extract_string(props_json, '$.parentLocalFunctionStableId'),
                 json_extract_string(props_json, '$.parentFnStableId')) AS owner_id
        FROM nodes""")
    n = db.execute("SELECT count(*) FROM numbered").fetchone()[0]
    if n != db.execute("SELECT count(DISTINCT stable_id) FROM numbered").fetchone()[0]:
        raise ValueError("Duplicate stable IDs")
    disposition = [(t, "forward") for t in sorted(FORWARD)]
    disposition += [(t, "reverse") for t in sorted(REVERSE)]
    disposition += [(t, "ignored") for t in sorted(IGNORED)]
    db.execute("CREATE TABLE policy(rel_type VARCHAR, direction VARCHAR)")
    db.executemany("INSERT INTO policy VALUES (?,?)", disposition)
    inventory = db.execute("""SELECT rel_type, count(*) AS count,
        coalesce(any_value(direction),'unclassified') AS disposition
        FROM rels LEFT JOIN policy USING(rel_type) GROUP BY rel_type ORDER BY count DESC""").fetchall()
    missing = db.execute("""SELECT count(*) FROM rels r
        LEFT JOIN numbered a ON a.stable_id=r.from_id
        LEFT JOIN numbered b ON b.stable_id=r.to_id
        WHERE a.idx IS NULL OR b.idx IS NULL""").fetchone()[0]
    if missing:
        raise ValueError(f"Relationships with missing endpoints: {missing}")
    db.execute("""CREATE TABLE deps AS
        SELECT DISTINCT CASE WHEN p.direction='reverse' THEN b.idx ELSE a.idx END AS consumer,
                        CASE WHEN p.direction='reverse' THEN a.idx ELSE b.idx END AS prerequisite
        FROM rels r JOIN policy p USING(rel_type)
        JOIN numbered a ON a.stable_id=r.from_id JOIN numbered b ON b.stable_id=r.to_id
        WHERE p.direction IN ('forward','reverse')
        UNION
        SELECT owner.idx, child.idx FROM numbered child JOIN numbered owner
        ON owner.stable_id=CASE WHEN list_contains(child.labels,'Step')
             OR (list_contains(child.labels,'Flow') AND list_contains(child.labels,'Block'))
             THEN child.owner_id ELSE child.step_id END
        WHERE child.idx<>owner.idx""")
    print(json.dumps({"phase": "load", "nodes": n}), flush=True)
    sources, targets = array("I"), array("I")
    cursor = db.execute("SELECT consumer, prerequisite FROM deps ORDER BY consumer, prerequisite")
    while batch := cursor.fetchmany(100000):
        for source, target in batch:
            sources.append(source)
            targets.append(target)
    outgoing, incoming = csr(n, sources, targets), csr(n, targets, sources)
    group, sizes = components(n, outgoing, incoming)
    cyclic = bytearray(size > 1 for size in sizes)
    for a, b in zip(sources, targets):
        if a == b:
            cyclic[group[a]] = 1
    print(json.dumps({"phase": "components", "components": len(sizes),
                      "cyclicComponents": sum(cyclic)}), flush=True)

    # Condensation removes only intra-component edges. Parallel external edges
    # are counted and discharged symmetrically, so deduplication is unnecessary.
    component_sources, component_targets = array("I"), array("I")
    component_remaining = array("I", [0]) * len(sizes)
    for a, b in zip(sources, targets):
        parent, child = group[a], group[b]
        if parent != child:
            component_sources.append(parent)
            component_targets.append(child)
            component_remaining[parent] += 1
    component_reverse = csr(len(sizes), component_targets, component_sources)
    component_level = array("i", [0]) * len(sizes)
    queue = deque(i for i, degree in enumerate(component_remaining) if degree == 0)
    completed_components = 0
    offsets, neighbors = component_reverse
    while queue:
        child = queue.popleft()
        completed_components += 1
        for pos in range(offsets[child], offsets[child + 1]):
            parent = neighbors[pos]
            component_level[parent] = max(component_level[parent], component_level[child] + 1)
            component_remaining[parent] -= 1
            if component_remaining[parent] == 0:
                queue.append(parent)
    assert completed_components == len(sizes), 'Condensation must be acyclic'
    expected_component_level = array("i", [0]) * len(sizes)
    for parent, child in zip(component_sources, component_targets):
        assert component_level[parent] > component_level[child]
        expected_component_level[parent] = max(expected_component_level[parent], component_level[child] + 1)
    assert component_level == expected_component_level
    del component_sources, component_targets, component_reverse, expected_component_level

    # SCCs are diagnostics, NOT synthetic ready tasks. Only true DAG leaves
    # seed the structural waves; all consumers of a cycle stay blocked.
    remaining = array("I", (outgoing[0][i+1]-outgoing[0][i] for i in range(n)))
    level = array("i", [-1]) * n
    maximum = array("i", [0]) * n
    queue = deque(i for i in range(n) if remaining[i] == 0)
    for i in queue:
        level[i] = 0
    offsets, neighbors = incoming
    while queue:
        child = queue.popleft()
        for pos in range(offsets[child], offsets[child+1]):
            parent = neighbors[pos]
            remaining[parent] -= 1
            maximum[parent] = max(maximum[parent], level[child]+1)
            if not remaining[parent]:
                level[parent] = maximum[parent]
                queue.append(parent)

    # Unknown relation semantics taint both endpoints conservatively, then all
    # their consumers. This is distinct from graph cycles and from profile proof.
    unknown = bytearray(n)
    for (i,) in db.execute("""SELECT DISTINCT idx FROM (
        SELECT a.idx FROM rels r LEFT JOIN policy p USING(rel_type)
        JOIN numbered a ON a.stable_id=r.from_id WHERE p.direction IS NULL
        UNION SELECT b.idx FROM rels r LEFT JOIN policy p USING(rel_type)
        JOIN numbered b ON b.stable_id=r.to_id WHERE p.direction IS NULL)""").fetchall():
        unknown[i] = 1
    queue = deque(i for i in range(n) if unknown[i])
    direct_unknown = len(queue)
    while queue:
        child = queue.popleft()
        for pos in range(offsets[child], offsets[child+1]):
            parent = neighbors[pos]
            if not unknown[parent]:
                unknown[parent] = 1
                queue.append(parent)

    # Verify every dependency, not a sample. Ready consumers must have all
    # prerequisites on strictly lower levels and satisfy the max recurrence.
    for a, b in zip(sources, targets):
        if level[a] >= 0:
            assert 0 <= level[b] < level[a], (a, b, level[a], level[b])
    for i in range(n):
        if level[i] >= 0:
            assert level[i] == maximum[i]
            assert level[i] == component_level[group[i]]
        elif not cyclic[group[i]]:
            assert remaining[i] > 0

    result = pa.table({"idx": range(n), "component": group,
                       "component_level": [component_level[group[i]] for i in range(n)],
                       "structural_level": level,
                       "in_cycle": [bool(cyclic[group[i]]) for i in range(n)],
                       "unknown_dependency_semantics": [bool(x) for x in unknown]})
    db.register("levels", result)
    destination = str(args.output / "levels.parquet").replace("'", "''")
    db.execute(f"""COPY (SELECT stable_id, labels, component, structural_level, component_level,
        in_cycle, unknown_dependency_semantics,
        CASE WHEN in_cycle THEN 'cyclic-dependency'
             WHEN structural_level<0 THEN 'depends-on-cycle'
             ELSE 'acyclic' END AS dependency_status,
        false AS code_recursion_confirmed
        FROM numbered JOIN levels USING(idx)
        ORDER BY idx) TO '{destination}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
    largest = sorted((i for i in range(len(sizes)) if cyclic[i]), key=lambda i: -sizes[i])[:10]
    samples = {}
    for key in largest:
        rows = db.execute("""SELECT stable_id FROM numbered JOIN levels USING(idx)
            WHERE component=? ORDER BY stable_id LIMIT 5""", [key]).fetchall()
        samples[key] = {"size": sizes[key], "level": component_level[key], "sampleIds": [r[0] for r in rows]}
    reciprocal = db.execute("""SELECT x.stable_id, y.stable_id FROM deps a
        JOIN deps b ON a.consumer=b.prerequisite AND a.prerequisite=b.consumer
        JOIN numbered x ON x.idx=a.consumer JOIN numbered y ON y.idx=a.prerequisite
        JOIN levels l ON l.idx=a.consumer
        WHERE a.consumer<a.prerequisite AND l.component=? LIMIT 1""",
        [largest[0] if largest else -1]).fetchone()
    witness = []
    if reciprocal:
        for consumer, prerequisite in [reciprocal, reciprocal[::-1]]:
            evidence = db.execute("""SELECT r.rel_type, p.direction FROM rels r
                JOIN policy p USING(rel_type)
                WHERE (p.direction='forward' AND r.from_id=? AND r.to_id=?)
                   OR (p.direction='reverse' AND r.to_id=? AND r.from_id=?)""",
                [consumer, prerequisite, consumer, prerequisite]).fetchall()
            witness.append({"consumer": consumer, "prerequisite": prerequisite,
                            "evidence": evidence or [["direct ownership property", "parent-to-child"]]})
    counts = Counter(level)
    policy = {"forward": sorted(FORWARD), "reverse": sorted(REVERSE),
              "ignored": sorted(IGNORED), "ownership": "parent -> direct child",
              "unknown": "both endpoints and their consumers are uncertain"}
    report = {
        "mode": "global-materialized-dependency-inventory", "version": 3,
        "componentLevelRule": "SCC condensation: sinks=0, consumer=1+max(external prerequisites)",
        "components": len(sizes),
        "componentLevels": dict(sorted(Counter(component_level).items())),
        "maxComponentLevel": max(component_level, default=0),
        "annotationProfilesCertified": False, "generatesAnnotations": False,
        "writesDatabase": False, "source": str(args.parquet.resolve()),
        "provenanceIds": [r[0] for r in db.execute("SELECT DISTINCT provenance_id FROM nodes").fetchall()],
        "policy": policy,
        "policyHash": hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest(),
        "nodes": n, "relationships": sum(r[1] for r in inventory),
        "dependencies": len(sources), "structurallyLeveled": n-counts[-1],
        "blockedByCycles": counts[-1], "cyclicComponents": sum(cyclic),
        "nodesInCycles": sum(size for i, size in enumerate(sizes) if cyclic[i]),
        "unknownDirectNodes": direct_unknown, "unknownIncludingConsumers": sum(unknown),
        "levels": dict(sorted((k,v) for k,v in counts.items() if k >= 0)),
        "largestCycles": samples,
        "reciprocalCycleWitness": witness,
        "structurallyIsolatedNodes": sum(outgoing[0][i]==outgoing[0][i+1]
            and incoming[0][i]==incoming[0][i+1] for i in range(n)),
        "relationInventory": [{"type": t,"count": count,"disposition": d} for t,count,d in inventory],
        "verification": "all dependency edges checked; individual and component levels satisfy max(external dependencies)+1; all components processed; existing individual levels unchanged",
        "elapsedSeconds": round(time.perf_counter()-started, 3),
    }
    (args.output / "summary.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k:v for k,v in report.items() if k not in {
        "policy", "levels", "componentLevels", "largestCycles", "relationInventory"}}), flush=True)
    db.close()


if __name__ == "__main__":
    main()
