"""Track a fixed full-snapshot issue cohort using verified scoped evidence only."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess

import duckdb


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--evidence', nargs=3, action='append', default=[],
                        metavar=('BEFORE', 'AFTER', 'VALIDATOR'))
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    baseline = args.baseline.resolve()
    provenance = json.loads((baseline/'summary.json').read_text(encoding='utf-8'))['provenance']
    db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})
    try:
        rows = db.execute('''SELECT stable_id,decision,evidence_reason,owner_status
            FROM read_parquet(?) WHERE starts_with(decision,'blocked-')
                OR starts_with(decision,'review-') ORDER BY stable_id''',
            [str(baseline/'inventory'/'annotation-plan.parquet')]).fetchall()
        issues = {stable_id: {'stableId': stable_id, 'baselineDecision': decision,
                             'reason': reason, 'ownerStatus': owner,
                             'status': 'open', 'evidence': []}
                  for stable_id, decision, reason, owner in rows}
        assert len(issues) == len(rows), 'Duplicate issue identities'
        verified = []
        for before_arg, after_arg, validator_arg in args.evidence:
            before, after, validator = (Path(p).resolve() for p in (before_arg, after_arg, validator_arg))
            if not validator.is_relative_to(root/'dev') or validator.suffix != '.mts':
                raise ValueError('Use a repository integration validator under dev/')
            for snapshot in (before, after):
                source = json.loads((snapshot/'summary.json').read_text(encoding='utf-8'))['provenance']
                for field in ('source_revision', 'source_dirty_fingerprint'):
                    if source.get(field) != provenance.get(field):
                        raise ValueError(f'Source provenance mismatch: {snapshot}: {field}')
            command = ['node', '--import', 'tsx', str(validator), str(after), str(before),
                       str(args.source_root.resolve())]
            result = subprocess.run(command, cwd=root, capture_output=True, text=True,
                                    encoding='utf-8', errors='strict', check=True, timeout=120)
            records = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            if not records or not records[-1].get('ok') or records[-1].get('writesNeo4j') is not False:
                raise ValueError(f'Validator did not certify a read-only scoped check: {validator}')
            evidence_id = len(verified)
            verified.append({'before': str(before), 'after': str(after), 'validator': str(validator),
                             'command': command, 'verification': records[-1]})
            candidates = db.execute('''SELECT b.stable_id,a.decision,a.context_targets
                FROM read_parquet(?) b JOIN read_parquet(?) a USING(stable_id)
                WHERE (starts_with(b.decision,'blocked-') OR starts_with(b.decision,'review-'))
                  AND NOT (starts_with(a.decision,'blocked-') OR starts_with(a.decision,'review-')
                           OR starts_with(a.decision,'deferred-'))''',
                [str(before/'inventory'/'annotation-plan.parquet'),
                 str(after/'inventory'/'annotation-plan.parquet')]).fetchall()
            confirmed_ids = records[-1].get('confirmedStableIds')
            if confirmed_ids is not None:
                confirmed_ids = set(confirmed_ids)
                candidate_ids = {candidate[0] for candidate in candidates}
                if not confirmed_ids <= candidate_ids:
                    raise ValueError('Validator claimed IDs without a confirmed plan transition')
            for stable_id, decision, targets in candidates:
                if confirmed_ids is not None and stable_id not in confirmed_ids:
                    continue
                if stable_id not in issues:
                    continue
                issues[stable_id]['status'] = 'confirmed-scoped'
                issues[stable_id]['evidence'].append({'check': evidence_id, 'decision': decision,
                                                     'contextTargets': targets})
            for replacement in records[-1].get('replacedStableIds', []):
                stable_id = replacement['stableId']
                target = replacement['replacementStableId']
                before_decision = db.execute('SELECT decision FROM read_parquet(?) WHERE stable_id=?',
                    [str(before/'inventory'/'annotation-plan.parquet'), stable_id]).fetchone()
                old_count = db.execute('SELECT count(*) FROM read_parquet(?) WHERE stable_id=?',
                    [str(after/'parquet'/'nodes.parquet'), stable_id]).fetchone()[0]
                target_plan = db.execute('SELECT decision,context_targets FROM read_parquet(?) WHERE stable_id=?',
                    [str(after/'inventory'/'annotation-plan.parquet'), target]).fetchone()
                if (not before_decision or not before_decision[0].startswith(('blocked-', 'review-'))
                    or old_count or stable_id == target or not target_plan
                    or target_plan[0].startswith(('blocked-', 'review-'))):
                    raise ValueError(f'Unconfirmed source identity replacement: {stable_id}')
                if stable_id not in issues:
                    continue
                issues[stable_id]['status'] = 'confirmed-scoped'
                issues[stable_id]['evidence'].append({'check': evidence_id, 'kind': 'source-identity-repair',
                    'replacementStableId': target, 'decision': target_plan[0], 'contextTargets': target_plan[1],
                    'sourceExpansionStillDeferred': target_plan[0].startswith('deferred-')})
        counts = dict(Counter(issue['status'] for issue in issues.values()))
        open_by_decision = dict(Counter(issue['baselineDecision'] for issue in issues.values()
                                        if issue['status'] == 'open'))
        report = {'version': 1, 'baseline': str(baseline), 'baselineProvenanceId': provenance['id'],
                  'sourceRevision': provenance['source_revision'], 'updatedAt': datetime.now(timezone.utc).isoformat(),
                  'baselineIssues': len(issues), 'counts': counts, 'openByDecision': open_by_decision,
                  'checks': verified, 'issues': list(issues.values()),
                  'writesNeo4j': False, 'runsExtraction': False, 'generatesAnnotations': False,
                  'limitations': ['Tracks only the fixed baseline cohort, not newly introduced findings.',
                                  'Scoped confirmation is not a full-graph certification.',
                                  'Evidence refers to immutable snapshots, not live Neo4j or current source changes.']}
        args.output.mkdir(parents=True, exist_ok=True)
        destination = args.output/'issues.json'
        if destination.exists():
            existing = json.loads(destination.read_text(encoding='utf-8'))
            if existing['baselineProvenanceId'] != report['baselineProvenanceId']:
                raise ValueError('Cannot replace a ledger with a different baseline cohort')
            previous_checks = {(check['before'], check['after'], check['validator']) for check in existing['checks']}
            current_checks = {(check['before'], check['after'], check['validator']) for check in verified}
            if not previous_checks <= current_checks:
                raise ValueError('Provide all previous evidence checks; confirmations must not disappear')
        destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({key: report[key] for key in ('baselineIssues', 'counts', 'openByDecision',
              'writesNeo4j', 'runsExtraction')} | {'report': str(destination)}, ensure_ascii=False))
    finally:
        db.close()


if __name__ == '__main__':
    main()
