import re


def validate_provenance(record):
    if not isinstance(record, dict) or not re.fullmatch(r'[a-f0-9]{64}', record.get('id', '')):
        raise ValueError('Missing or invalid extraction provenance; re-extract legacy data')
    for key in ('extractor_commit', 'source_revision'):
        if not re.fullmatch(r'[a-f0-9]{40,64}', record.get(key, '')):
            raise ValueError(f'Invalid {key}')
    for key in ('extractor_dirty_fingerprint', 'source_dirty_fingerprint'):
        if key not in record or (record[key] is not None and not re.fullmatch(r'[a-f0-9]{64}', record[key])):
            raise ValueError(f'Invalid {key}')
    if not record.get('extracted_at'):
        raise ValueError('Missing extraction timestamp')
    return record


def register_provenance(session, records):
    records = [validate_provenance(record) for record in records]
    session.run('''UNWIND $records AS record
        MERGE (p:ExtractionProvenance {id:record.id})
        ON CREATE SET p += record''', records=records).consume()


def check_scoped_provenance(session, payload, batch_size=1000):
    record = validate_provenance(payload.get('provenance'))
    ids = set()
    for key in ('functions', 'nodes', 'resources', 'semanticEntities', 'edges',
                'resourceEdges', 'resourceLinks', 'semanticRelationships'):
        for row in payload.get(key, []):
            if row.get('props', {}).get('provenance_id') != record['id']:
                raise ValueError(f'Fact in {key} has missing or inconsistent provenance')
            if key in ('functions', 'nodes', 'resources', 'semanticEntities'):
                ids.add(row['stableId'])
    ordered = sorted(ids)
    for start in range(0, len(ordered), batch_size):
        conflict = session.run('''MATCH (n) WHERE n.stableId IN $ids
            AND (n.provenance_id IS NULL OR n.provenance_id <> $provenance)
            RETURN n.stableId AS stableId LIMIT 1''',
            ids=ordered[start:start + batch_size], provenance=record['id']).single()
        if conflict:
            raise ValueError(f"Provenance conflict at {conflict['stableId']}; use an explicit full replacement, not a mixed scoped import")
        conflict = session.run('''MATCH (a)-[r]->(b)
            WHERE a.stableId IN $ids AND r.source = 'semantic/functionFlowGraph'
              AND (r.provenance_id IS NULL OR r.provenance_id <> $provenance)
            RETURN a.stableId AS stableId LIMIT 1''',
            ids=ordered[start:start + batch_size], provenance=record['id']).single()
        if conflict:
            raise ValueError(f"Relationship provenance conflict at {conflict['stableId']}")
    return record
