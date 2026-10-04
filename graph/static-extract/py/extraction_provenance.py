import json
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
    records = [{key: json.dumps(value, ensure_ascii=False, sort_keys=True)
                if isinstance(value, dict) or (isinstance(value, list)
                    and any(isinstance(item, (dict, list)) for item in value)) else value
                for key, value in validate_provenance(record).items()} for record in records]
    session.run('''UNWIND $records AS record
        MERGE (p:ExtractionProvenance {id:record.id})
        ON CREATE SET p += record''', records=records).consume()


def check_scoped_provenance(session, payload, batch_size=1000, *, fn_stable_id=None):
    record = validate_provenance(payload.get('provenance'))
    ids = set()
    for key in ('functions', 'nodes', 'resources', 'semanticEntities', 'edges',
                'resourceEdges', 'resourceLinks', 'semanticRelationships'):
        for row in payload.get(key, []):
            if row.get('props', {}).get('provenance_id') != record['id']:
                raise ValueError(f'Fact in {key} has missing or inconsistent provenance')
            if key in ('functions', 'nodes', 'resources', 'semanticEntities'):
                ids.add(row['stableId'])
    if fn_stable_id:
        return prepare_scoped_replacement(session, payload, record, fn_stable_id, batch_size)
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


def prepare_scoped_replacement(session, payload, record, fn_stable_id, batch_size):
    """Allow extractor revisions for the same source; retain equal shared facts.

    No writes occur here. Conflicting shared facts and unknown/source-changed
    provenance still require an explicitly broader replacement.
    """
    node_keys = ('functions', 'nodes', 'resources', 'semanticEntities')
    edge_keys = ('edges', 'resourceEdges', 'resourceLinks', 'semanticRelationships')
    rows = [row for key in node_keys for row in payload.get(key, [])]
    ids = sorted({row['stableId'] for row in rows})
    existing = {}
    for start in range(0, len(ids), batch_size):
        for row in session.run('''MATCH (n) WHERE n.stableId IN $ids
            RETURN n.stableId AS id, properties(n) AS props, labels(n) AS labels''', ids=ids[start:start+batch_size]):
            if row['id'] in existing:
                raise ValueError(f"Duplicate stableId: {row['id']}")
            existing[row['id']] = dict(row)
    old_ids = {row['props'].get('provenance_id') for row in existing.values()}
    if None in old_ids:
        raise ValueError('Scoped replacement requires provenance on existing nodes')
    records = {row['id']: row['props'] for row in session.run('''MATCH (p:ExtractionProvenance)
        WHERE p.id IN $ids RETURN p.id AS id,properties(p) AS props''', ids=list(old_ids))}
    for old_id in old_ids:
        old = records.get(old_id)
        if not old or any(old.get(key) != record.get(key) for key in ('source_revision', 'source_dirty_fingerprint', 'extraction_options')):
            raise ValueError(f'Source/options provenance conflict: {old_id}; scoped extractor upgrade requires the same source snapshot')
    file, sl, sc, el, ec = fn_stable_id.rsplit(':', 4)
    lower, upper = (int(sl), int(sc)), (int(el), int(ec))

    def owned(stable_id, props):
        if stable_id == fn_stable_id or any(props.get(key) == fn_stable_id for key in
                ('parentFnStableId', 'parent_fn_stable_id')):
            return True
        if props.get('repoRelativePath') != file:
            return False
        coordinates = [props.get(key) for key in ('startLine', 'startColumn', 'endLine', 'endColumn')]
        return all(isinstance(v, int) for v in coordinates) and lower <= tuple(coordinates[:2]) and tuple(coordinates[2:]) <= upper

    scope = {row['stableId'] for row in rows if owned(row['stableId'], row.get('props', {}))}
    scope.update(stable_id for stable_id, row in existing.items() if owned(stable_id, row['props']))
    ignored = {'provenance_id', 'roles', 'flow_labels'}

    def equivalent(props, old, extra_ignored=()):
        return all(old.get(key) == value for key, value in props.items()
                   if key not in ignored and key not in extra_ignored and value is not None)

    preserved = set()
    function_catalog_rows = {id(row) for row in payload.get('functions', [])}
    for row in rows:
        stable_id = row['stableId']
        old = existing.get(stable_id)
        if old and stable_id not in scope:
            # A shared catalog Fn carries a call-site name, not a rename of the
            # canonical definition. Preserve the existing node, including name.
            catalog_name = id(row) in function_catalog_rows and set(row['labels']) == {'Fn'} and 'Fn' in old['labels']
            if not equivalent(row['props'], old['props'], ('name',) if catalog_name else ()) or not set(row['labels']).issubset(old['labels']):
                raise ValueError(f'Shared dependency changed outside scope: {stable_id}; include its owner in a replacement')
            preserved.add(stable_id)
    # Shared-source relationships must not be swept by scoped cleanup.
    shared_edges = []
    for key in edge_keys:
        for row in payload.get(key, []):
            source = row.get('fromId', row.get('sourceStableId', row.get('flowNodeStableId')))
            target = row.get('toId', row.get('targetStableId', row.get('stableId')))
            kind = row.get('type', row.get('relType'))
            if source in preserved and target not in scope:
                shared_edges.append({'source': source, 'target': target, 'kind': kind})
    shared_existing = {}
    for start in range(0, len(shared_edges), batch_size):
        batch = shared_edges[start:start+batch_size]
        # Without a universal label index, UNWIND + endpoint MATCH scans nodes
        # once per edge. Read a candidate batch once, then use exact tuple keys.
        for item in session.run('''MATCH (a)-[r]->(b)
            WHERE a.stableId IN $sources AND b.stableId IN $targets AND type(r) IN $kinds
            RETURN a.stableId AS source,b.stableId AS target,type(r) AS kind,properties(r) AS props''',
                sources=list({edge['source'] for edge in batch}),
                targets=list({edge['target'] for edge in batch}),
                kinds=list({edge['kind'] for edge in batch})):
            shared_existing.setdefault((item['source'], item['target'], item['kind']), []).append(item['props'])
    retained_edges = {}
    for key in edge_keys:
        retained_edges[key] = []
        for row in payload.get(key, []):
            source = row.get('fromId', row.get('sourceStableId', row.get('flowNodeStableId')))
            target = row.get('toId', row.get('targetStableId', row.get('stableId')))
            kind = row.get('type', row.get('relType'))
            if source in preserved and target not in scope:
                matches = shared_existing.get((source, target, kind), [])
                if not any(equivalent(row['props'], props) for props in matches):
                    raise ValueError(f'Shared relationship changed outside scope: {source} -{kind}-> {target}')
                continue
            retained_edges[key].append(row)
    for key in node_keys:
        payload[key] = [row for row in payload.get(key, []) if row['stableId'] not in preserved]
    payload.update(retained_edges)
    payload['_scopedReplacement'] = {'scopeIds': sorted(scope), 'preservedSharedNodes': len(preserved),
        'previousProvenanceIds': sorted(old_ids), 'policy': 'same-source-scoped-extractor-upgrade-v1'}
    return record
