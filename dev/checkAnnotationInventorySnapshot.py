"""Verify inventory contracts on an actual extraction snapshot."""
import argparse
import json
from pathlib import Path

import duckdb


def verify(report):
    summary = json.loads((report/'summary.json').read_text(encoding='utf-8'))
    plan = json.loads((report/'annotation-plan.json').read_text(encoding='utf-8'))
    db = duckdb.connect()
    try:
        db.execute("SET memory_limit='1GB'")
        db.execute('SET threads=1')
        for name, file in [('subjects', report/'subjects.parquet'),
                           ('plan', report/'annotation-plan.parquet')]:
            db.read_parquet(str(file)).create_view(name)
            assert db.execute(f'SELECT count(*),count(DISTINCT stable_id) FROM {name}').fetchone() == (
                summary['nodes'], summary['nodes']), name
        assert dict(db.execute('SELECT mode,count(*) FROM subjects GROUP BY mode').fetchall()) == summary['counts']
        assert dict(db.execute('SELECT decision,count(*) FROM plan GROUP BY decision').fetchall()) == plan['counts']
        assert plan['provenanceIds'] == summary['provenanceIds']
        assert plan['nodes'] == summary['nodes']
        assert not summary['generatesAnnotations'] and not summary['writesGraph']
        assert db.execute('SELECT count(*) FROM plan WHERE scheduled OR NOT retain_context').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM subjects WHERE body_count<>len(body_targets)').fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM subjects WHERE mode='inline' AND len(owners)=0").fetchone()[0] == 0
        assert db.execute('''SELECT count(*) FROM plan WHERE decision='compose-in-owner'
            AND (len(context_targets)<>1 OR owner_status<>'unique-direct-owner'
                 OR immediate_owner_evidence IS NULL)''').fetchone()[0] == 0
        checked = []
        columns = {row[0] for row in db.execute('DESCRIBE plan').fetchall()}
        for column in ('context_targets', 'required_body_context', 'required_type_context',
                       'required_value_context', 'required_callable_context', 'immediate_owner_targets'):
            if column not in columns:
                continue
            missing = db.execute(f'''WITH targets AS (
                SELECT unnest({column}) AS target FROM plan)
                SELECT count(*) FROM targets ANTI JOIN subjects s ON s.stable_id=target''').fetchone()[0]
            assert missing == 0, (column, missing)
            checked.append(column)
        return {'ok': True, 'nodes': summary['nodes'], 'provenanceIds': summary['provenanceIds'],
                'dependencyColumnsChecked': checked, 'decisions': plan['counts'],
                'generatesAnnotations': False, 'writesGraph': False}
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    print(json.dumps(verify(parser.parse_args().report)))
