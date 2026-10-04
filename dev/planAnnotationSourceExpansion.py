"""Plan one source-expansion wave and compare it with a real extracted snapshot."""
import argparse
import json
from collections import Counter
from pathlib import Path, PurePosixPath

import duckdb


def load_snapshot(db, path):
    nodes = {key: json.loads(props) for key, props in db.read_parquet(
        str(path/'parquet/nodes.parquet')).project('stable_id,props_json').fetchall()}
    plan = {key: decision for key, decision in db.read_parquet(
        str(path/'inventory/annotation-plan.parquet')).project('stable_id,decision').fetchall()}
    return nodes, plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--expanded', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--max-files', type=int, help='Limit this wave to the most requested files.')
    args = parser.parse_args()
    if args.max_files is not None and args.max_files < 1:
        parser.error('--max-files must be positive')
    db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})
    nodes, plan = load_snapshot(db, args.snapshot)
    pending = []
    invalid = []
    files = Counter()
    for key, decision in sorted(plan.items()):
        if decision != 'deferred-source-expansion':
            continue
        props = nodes[key]
        file = props.get('repoRelativePath')
        path = PurePosixPath(file.replace('\\', '/')) if file else None
        valid = bool(path and not path.is_absolute() and '..' not in path.parts
                     and ':' not in str(path))
        row = {'stableId': key, 'file': file, 'sourceCoverage': props.get('sourceCoverage')}
        pending.append(row)
        if valid:
            files[str(path)] += 1
        else:
            invalid.append(row)
    selected_files = sorted(files, key=lambda file: (-files[file], file))
    if args.max_files is not None:
        selected_files = selected_files[:args.max_files]
    selected = set(selected_files)
    selected_pending = [row for row in pending if row['file']
                        and row['file'].replace('\\', '/') in selected]
    result = {'version': 2, 'snapshot': str(args.snapshot),
        'pendingDeclarations': len(pending),
        'selectedDeclarations': len(selected_pending), 'maxFiles': args.max_files,
        'requestedFiles': [{'file': file, 'declarations': files[file]} for file in selected_files],
        'sourceRootsArgument': ';'.join(selected_files), 'invalidSourcePaths': invalid,
        'pending': selected_pending, 'writesGraph': False, 'generatesAnnotations': False,
        'scopePolicy': 'Add requested files to the existing scope; no automatic recursive expansion.'}
    if args.expanded:
        expanded_nodes, expanded_plan = load_snapshot(db, args.expanded)
        transitions = []
        for row in selected_pending:
            key = row['stableId']
            props = expanded_nodes.get(key, {})
            coverage = props.get('sourceCoverage')
            decision = expanded_plan.get(key)
            status = ('missing' if key not in expanded_nodes else 'still-deferred'
                      if decision == 'deferred-source-expansion' else 'coverage-not-confirmed'
                      if coverage != 'syntax-extracted' else 'source-expanded')
            transitions.append({**row, 'status': status, 'newSourceCoverage': coverage,
                                'newDecision': decision})
        result['comparison'] = {'expandedSnapshot': str(args.expanded),
            'statuses': dict(Counter(row['status'] for row in transitions)),
            'decisions': dict(Counter(row['newDecision'] for row in transitions)),
            'transitions': transitions,
            'newDeferredDeclarations': sorted(key for key, decision in expanded_plan.items()
                if decision == 'deferred-source-expansion' and plan.get(key) != decision),
            'expandedPlanCounts': dict(Counter(expanded_plan.values()))}
    db.close()
    content = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        if args.output.exists():
            raise FileExistsError(f'Refusing to overwrite an existing report: {args.output}')
        args.output.write_text(content+'\n', encoding='utf-8')
    print(content)


if __name__ == '__main__':
    main()
