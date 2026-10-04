"""Deterministic context allocation; candidates are not mandatory LLM jobs."""
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
summary = json.loads((args.report/'summary.json').read_text(encoding='utf-8'))
audit = json.loads((args.report/'body-audit.json').read_text(encoding='utf-8'))
spill = TemporaryDirectory(prefix='annotation-subject-plan-')
db = duckdb.connect(config={'temp_directory': spill.name})
db.execute("SET memory_limit='1GB'")
db.execute('SET threads=1')
db.execute('SET preserve_insertion_order=false')
db.read_parquet(str(args.report/'subjects.parquet')).create_view('subjects')
db.read_parquet(str(Path(summary['input'])/'relationships.parquet')).create_view('rels')
db.read_parquet(str(Path(summary['input'])/'nodes.parquet')).create_view('raw_nodes')
db.execute('''CREATE TABLE technical_flow_joins AS SELECT stable_id FROM raw_nodes
    WHERE list_contains(labels,'Join') AND json_extract_string(props_json,'$.operation_code')
      IN ('FLOW_JOIN','ARG_JOIN','FIELD_JOIN','OPERAND_JOIN')
      AND json_extract_string(props_json,'$.synthetic')='true' ''')
db.execute('''CREATE TABLE structural_owner_props AS SELECT stable_id,
    json_extract_string(props_json,'$.parentFlowBlockStableId') AS block_id,
    json_extract_string(props_json,'$.parentLocalFunctionStableId') AS local_id,
    json_extract_string(props_json,'$.parentFnStableId') AS fn_id
    FROM raw_nodes WHERE list_has_any(labels,['Step','Block'])
      OR stable_id IN (SELECT stable_id FROM technical_flow_joins)''')
# Field-bearing AST edges describe direct containment. Projection edges only
# describe an ancestor and must not compete with an immediate owner.
# A shared terminal's explicit control scope is as direct as AST containment;
# an inherited parentStep is its layout context, not a competing semantic owner.
# Insert evidence sources separately to bound peak join memory. Deduplicate
# after selecting the nearest tier, before aggregating owner evidence.
db.execute('''CREATE TABLE owner_candidates AS
    SELECT r.to_id AS stable_id,r.from_id AS target,r.rel_type AS relation,
      json_extract_string(r.props_json,'$.field') AS field,
      CASE WHEN r.rel_type IN ('HAS_OPERATION','HAS_SYNTAX_ENTRY') THEN 1 ELSE 0 END AS tier
    FROM rels r JOIN subjects s ON s.stable_id=r.to_id
    JOIN subjects owner ON owner.stable_id=r.from_id
    WHERE r.from_id<>r.to_id AND (
      (r.rel_type='AST_CHILD' AND json_extract_string(r.props_json,'$.field') IS NOT NULL
        AND json_extract_string(r.props_json,'$.projection') IS NULL)
      OR (r.rel_type IN ('HAS_OPERATION','HAS_SYNTAX_ENTRY') AND json_extract_string(r.props_json,'$.ownership')='immediate-step')
      OR (r.rel_type='HAS_TERMINAL' AND json_extract_string(r.props_json,'$.ownership')='direct-terminal-scope')
      OR (r.rel_type IN ('HAS_MEMBER','HAS_PROPERTY') AND json_extract_string(r.props_json,'$.ownership')='direct'))
    ''')
db.execute('''INSERT INTO owner_candidates
    SELECT r.to_id,r.from_id,'HAS_MEMBER','finite-domain-member',0
    FROM rels r JOIN raw_nodes member ON member.stable_id=r.to_id
    JOIN subjects domain ON domain.stable_id=r.from_id
    WHERE r.rel_type='HAS_MEMBER' AND r.from_id<>r.to_id
      AND list_contains(member.labels,'LiteralDomainValue')
      AND list_contains(domain.labels,'LiteralDomain')
      AND json_extract_string(member.props_json,'$.domain_stable_id')=r.from_id
      AND json_extract_string(member.props_json,'$.ordinal')=json_extract_string(r.props_json,'$.ordinal')
    ''')

db.execute('''INSERT INTO owner_candidates
    SELECT property.to_id,property.from_id,'HAS_PROPERTY','argument-object-property',-1
    FROM rels property JOIN subjects member ON member.stable_id=property.to_id
    JOIN subjects object_owner ON object_owner.stable_id=property.from_id
    WHERE property.rel_type='HAS_PROPERTY' AND property.from_id<>property.to_id
      AND list_contains(member.labels,'PropertyValue')
      AND list_has_all(object_owner.labels,['ObjectConstruction','ArgumentValue'])
      AND EXISTS (SELECT 1 FROM rels argument JOIN rels ancestor
        ON ancestor.from_id=argument.from_id AND ancestor.to_id=property.to_id
          AND ancestor.rel_type='HAS_PROPERTY'
        WHERE argument.rel_type='HAS_ARGUMENT' AND argument.to_id=property.from_id)
    ''')

db.execute('''INSERT INTO owner_candidates
    SELECT r.from_id,r.to_id,r.rel_type,'resource-cell',0
    FROM rels r JOIN raw_nodes cell ON cell.stable_id=r.from_id
    JOIN raw_nodes resource ON resource.stable_id=r.to_id
    WHERE r.rel_type='PART_OF' AND r.from_id<>r.to_id
      AND json_extract_string(r.props_json,'$.ownership')='direct-resource-cell'
      AND list_contains(cell.labels,'Cell')
      AND json_extract_string(cell.props_json,'$.parentStableId')=r.to_id
    ''')
db.execute('''INSERT INTO owner_candidates
    SELECT r.to_id,r.from_id,r.rel_type,'function-resource-context',4
    FROM rels r JOIN raw_nodes resource ON resource.stable_id=r.to_id
    JOIN subjects owner ON owner.stable_id=r.from_id
    WHERE r.rel_type='HAS_RESOURCE' AND r.from_id<>r.to_id
      AND json_extract_string(r.props_json,'$.ownership')='function-local-resource'
      AND (json_extract_string(resource.props_json,'$.resource_context_scope')='function'
        OR (json_extract_string(resource.props_json,'$.resource_context_scope') IS NULL
          AND json_extract_string(resource.props_json,'$.resource_kind')='async-flow'))
      AND json_extract_string(resource.props_json,'$.parentFnStableId')=r.from_id
      AND list_has_any(owner.labels,['Fn','FnDeclaration','CallableDeclaration'])
    ''')
db.execute('''INSERT INTO owner_candidates
    SELECT r.to_id,r.from_id,'HAS_ARGUMENT','object-argument',0
    FROM rels r JOIN subjects child ON child.stable_id=r.to_id
    JOIN subjects caller ON caller.stable_id=r.from_id
    WHERE r.rel_type='HAS_ARGUMENT' AND r.from_id<>r.to_id
      AND list_has_all(child.labels,['ObjectConstruction','ArgumentValue'])
      AND list_contains(caller.labels,'Call')
    ''')
db.execute('''INSERT INTO owner_candidates
    SELECT r.to_id,r.from_id,r.rel_type,'actual-argument',0
    FROM rels r JOIN raw_nodes child ON child.stable_id=r.to_id
    JOIN subjects caller ON caller.stable_id=r.from_id
    WHERE r.rel_type='MATERIALIZES_ARGUMENT' AND r.from_id<>r.to_id
      AND list_contains(caller.labels,'Call')
      AND json_extract_string(r.props_json,'$.semantic_expansion')='call-execution'
      AND json_extract_string(r.props_json,'$.protocol_role')='actual argument'
      AND json_extract_string(child.props_json,'$.sourceCallStableId')=r.from_id
    ''')
db.execute('''INSERT INTO owner_candidates
    SELECT n.stable_id,o.stable_id,'parentStepStableId',NULL,1
    FROM raw_nodes n JOIN subjects o
      ON o.stable_id=json_extract_string(n.props_json,'$.parentStepStableId')
    WHERE n.stable_id<>o.stable_id AND list_contains(o.labels,'Step')
    ''')
db.execute('''INSERT INTO owner_candidates
    SELECT n.stable_id,v.target,v.relation,NULL,v.tier
    FROM structural_owner_props n, LATERAL (VALUES
      (n.block_id,'parentFlowBlockStableId',2),
      (n.local_id,'parentLocalFunctionStableId',3),
      (n.fn_id,'parentFnStableId',4)
    ) v(target,relation,tier)
    WHERE nullif(v.target,'') IS NOT NULL
    ''')
db.execute('''INSERT INTO owner_candidates
    SELECT n.stable_id,v.target,v.relation,NULL,v.tier
    FROM raw_nodes n, LATERAL (VALUES
      (json_extract_string(n.props_json,'$.parentLocalFunctionStableId'),'parentLocalFunctionStableId',3),
      (json_extract_string(n.props_json,'$.parentFnStableId'),'parentFnStableId',4)
    ) v(target,relation,tier)
    WHERE list_has_any(n.labels,['FunctionStart','FunctionEnd']) AND nullif(v.target,'') IS NOT NULL
    ''')
db.execute('''INSERT INTO owner_candidates
    SELECT r.from_id,r.to_id,r.rel_type,NULL,2
    FROM rels r JOIN subjects s ON s.stable_id=r.from_id
    WHERE (list_has_any(s.labels,['Step','Block']) OR s.stable_id IN (SELECT stable_id FROM technical_flow_joins))
      AND r.rel_type='NESTED_IN'
      AND json_extract_string(r.props_json,'$.structure_kind')='containment'
    ''')
# A syntax parent is nearer than its enclosing step. Equal-tier disagreement
# Explicit AST ancestor projections are fallbacks, never peers of direct owners.
db.execute('''INSERT INTO owner_candidates
    SELECT r.from_id,r.to_id,r.rel_type,'nearest-materialized-ast-owner',5
    FROM rels r JOIN subjects s ON s.stable_id=r.from_id
    WHERE list_has_any(s.labels,['DeclarationContainer','SyntaxContainer']) AND r.rel_type='ENCLOSED_BY'
      AND (json_extract_string(r.props_json,'$.resolution')='nearest-materialized-ast-owner'
        OR json_extract_string(r.props_json,'$.syntaxOwnerResolution')='nearest-materialized-ast-owner')
    ''')
db.execute('''INSERT INTO owner_candidates
    SELECT r.to_id,r.from_id,r.rel_type,'composition-step-context',5
    FROM rels r JOIN subjects composition ON composition.stable_id=r.to_id
    JOIN subjects step ON step.stable_id=r.from_id
    WHERE r.rel_type='HAS_OPERATION' AND r.from_id<>r.to_id
      AND list_contains(composition.labels,'SyntaxComposition') AND list_contains(step.labels,'Step')
      AND json_extract_string(r.props_json,'$.ownership')='composition-step-context'
      AND json_extract_string(r.props_json,'$.resolution')='flow-syntax-composition' ''')

# An outer callback declaration context must not compete with its own body Step.
# Build only explicit lexical Step/function chains, not arbitrary graph reachability.
db.execute('''CREATE TABLE lexical_step_ancestors AS
    WITH RECURSIVE nesting(ancestor,descendant) AS (
      SELECT DISTINCT r.from_id,s.stable_id
      FROM rels r JOIN raw_nodes s
        ON json_extract_string(s.props_json,'$.parentFnStableId')=r.to_id
      WHERE r.rel_type='CONTAINS_CALLABLE' AND list_contains(s.labels,'Step')
        AND json_extract_string(r.props_json,'$.resolution')='ast-step-anchor'
        AND json_extract_string(r.props_json,'$.ownership')='lexical-step-context'
        AND r.from_id<>s.stable_id
      UNION
      SELECT n.ancestor,d.descendant FROM nesting n JOIN nesting d ON n.descendant=d.ancestor
    ) SELECT * FROM nesting''')
db.execute('''DELETE FROM owner_candidates outer_owner
    WHERE outer_owner.field='composition-step-context'
      AND EXISTS (SELECT 1 FROM owner_candidates inner_owner
        JOIN lexical_step_ancestors n ON n.ancestor=outer_owner.target AND n.descendant=inner_owner.target
        WHERE inner_owner.stable_id=outer_owner.stable_id
          AND inner_owner.field='composition-step-context'
          AND NOT EXISTS (SELECT 1 FROM lexical_step_ancestors reverse
            WHERE reverse.ancestor=n.descendant AND reverse.descendant=n.ancestor))''')
db.execute('DROP TABLE lexical_step_ancestors')

# Materialized syntax parts can lack a separate AST parent (operator tokens,
# for example). Explicit composition is weaker than AST/step ownership; retain
# every composition owner at the fallback tier so ambiguity stays visible.
db.execute('''INSERT INTO owner_candidates
    SELECT r.to_id,r.from_id,r.rel_type,'renderedExpression',6
    FROM rels r JOIN subjects part ON part.stable_id=r.to_id
    JOIN subjects owner ON owner.stable_id=r.from_id
    WHERE r.rel_type='COMPOSES_SYNTAX' AND r.from_id<>r.to_id
      AND list_contains(part.labels,'SyntaxPart')
      AND NOT list_has_any(part.labels,['Declaration','FunctionImplementation',
        'CallableDeclaration','Fn','FnDeclaration','TypeDeclaration','ValueDeclaration',
        'Parameter','MemberDeclaration','TypeMember','ValueSlot','Reference',
        'ValueReference','MemberReference','TypeReference','ResourceProxy'])
      AND part.declaration_kind IS NULL
      AND json_extract_string(r.props_json,'$.layer')='syntax-composition'
      AND json_extract_string(r.props_json,'$.field')='renderedExpression'
    ''')

# Composition may repeat the same tile on an operation and its enclosing Step.
# Discard only a proven ancestor, not an owner inferred from IDs or coordinates.
db.execute('''CREATE TABLE composition_containment AS
    SELECT DISTINCT r.from_id AS ancestor,r.to_id AS descendant FROM rels r
    WHERE r.from_id<>r.to_id AND (
      (r.rel_type='AST_CHILD' AND json_extract_string(r.props_json,'$.field') IS NOT NULL
        AND json_extract_string(r.props_json,'$.projection') IS NULL)
      OR (r.rel_type IN ('HAS_OPERATION','HAS_SYNTAX_ENTRY') AND json_extract_string(r.props_json,'$.ownership')='immediate-step')
      OR (r.rel_type IN ('HAS_MEMBER','HAS_PROPERTY') AND json_extract_string(r.props_json,'$.ownership')='direct'))
    ''')
db.execute('''DELETE FROM owner_candidates outer_owner WHERE outer_owner.tier=6
    AND EXISTS (SELECT 1 FROM owner_candidates inner_owner
      JOIN composition_containment c ON c.ancestor=outer_owner.target AND c.descendant=inner_owner.target
      WHERE inner_owner.stable_id=outer_owner.stable_id AND inner_owner.tier=6
        AND NOT EXISTS (SELECT 1 FROM owner_candidates nested_owner
          JOIN composition_containment nested ON nested.ancestor=inner_owner.target
            AND nested.descendant=nested_owner.target
          WHERE nested_owner.stable_id=outer_owner.stable_id AND nested_owner.tier=6)
        AND NOT EXISTS (SELECT 1 FROM composition_containment reverse
          WHERE reverse.ancestor=c.descendant AND reverse.descendant=c.ancestor))''')
db.execute('DROP TABLE composition_containment')

# Equal-tier disagreement without proven containment remains a conflict.
# Sorting stable IDs must never resolve ownership.
db.execute('''CREATE TABLE direct_evidence AS
    SELECT DISTINCT e.*, (t.stable_id IS NOT NULL AND e.target<>e.stable_id
      AND (e.tier<>6 OR NOT EXISTS (SELECT 1 FROM rels reverse
        WHERE reverse.from_id=e.stable_id AND reverse.to_id=e.target AND (
          (reverse.rel_type='AST_CHILD'
            AND json_extract_string(reverse.props_json,'$.field') IS NOT NULL
            AND json_extract_string(reverse.props_json,'$.projection') IS NULL)
          OR (reverse.rel_type='COMPOSES_SYNTAX'
            AND json_extract_string(reverse.props_json,'$.layer')='syntax-composition'
            AND json_extract_string(reverse.props_json,'$.field')='renderedExpression'))))
      AND (e.tier<>2 OR list_has_any(t.labels,['Step','Block']))
      AND (NOT list_has_any(s.labels,['FunctionStart','FunctionEnd']) OR e.tier<3
        OR list_has_any(t.labels,['Fn','FnDeclaration','CallableDeclaration']))
      AND (e.stable_id NOT IN (SELECT stable_id FROM technical_flow_joins) OR e.tier<3
        OR list_has_any(t.labels,['Fn','FnDeclaration','CallableDeclaration']))) AS target_valid
    FROM (SELECT * FROM owner_candidates
      QUALIFY tier=min(tier) OVER (PARTITION BY stable_id)) e
    JOIN subjects s ON s.stable_id=e.stable_id
    LEFT JOIN subjects t ON t.stable_id=e.target''')
db.execute('DROP TABLE owner_candidates')
# LIST aggregation cannot spill all intermediate states. Hash partitions bound
# its working set without changing grouping or the result's evidence ordering.
owner_aggregation = '''SELECT stable_id,
    list(DISTINCT target ORDER BY target) AS targets,
    bool_or(NOT target_valid) AS invalid_target,
    list(struct_pack(target:=target,relation:=relation,field:=field,tier:=tier)
      ORDER BY target,relation,field) AS evidence
    FROM direct_evidence WHERE {condition} GROUP BY stable_id'''
db.execute('CREATE TABLE direct_owners AS ' + owner_aggregation.format(condition='false'))
for bucket in range(16):
    db.execute('INSERT INTO direct_owners ' + owner_aggregation.format(
        condition=f'hash(stable_id)%16={bucket}'))
# Inline means context allocation, not an assertion that execution is synchronous.
# Other incoming functional links conservatively prevent callback folding.
db.execute('''CREATE TABLE callback_composition AS
    SELECT s.stable_id,d.targets FROM subjects s JOIN direct_owners d USING(stable_id)
    WHERE list_contains(s.labels,'CallbackImplementation') AND len(d.targets)=1
      AND EXISTS (SELECT 1 FROM direct_evidence e WHERE e.stable_id=s.stable_id
        AND e.target=d.targets[1] AND e.relation='AST_CHILD' AND e.field='arguments')
      AND EXISTS (SELECT 1 FROM rels r WHERE r.from_id=d.targets[1]
        AND r.to_id=s.stable_id AND r.rel_type='HAS_ARGUMENT')
      AND NOT EXISTS (SELECT 1 FROM rels r WHERE r.to_id=s.stable_id
        AND NOT (r.rel_type='CONTAINS_CALLABLE'
          AND json_extract_string(r.props_json,'$.ownership')='lexical-step-context'
          AND json_extract_string(r.props_json,'$.resolution')='ast-step-anchor')
        AND (r.rel_type NOT IN ('AST_CHILD','HAS_ARGUMENT','COMPOSES_SYNTAX','ENCLOSED_BY')
          OR (r.rel_type='HAS_ARGUMENT' AND r.from_id<>d.targets[1])))''')
db.execute('''CREATE TABLE object_arguments AS SELECT DISTINCT stable_id FROM direct_evidence
    WHERE relation='HAS_ARGUMENT' AND field='object-argument' ''')
db.execute('DROP TABLE direct_evidence')

# A capture is an occurrence of an existing binding, not a new definition.
# Validate the whole explicit predecessor chain; ambiguity/cycles remain review.
db.execute('''CREATE TABLE capture_links AS
    SELECT n.stable_id,json_extract_string(n.props_json,'$.originalStableId') AS original,
      list(DISTINCT r.from_id) FILTER(WHERE r.from_id IS NOT NULL) AS predecessors
    FROM raw_nodes n LEFT JOIN rels r ON r.to_id=n.stable_id AND r.rel_type='CAPTURES_VALUE'
    WHERE list_contains(n.labels,'CapturedBinding') GROUP BY n.stable_id,original''')
db.execute('''CREATE TABLE capture_edges AS
    SELECT c.stable_id,c.original,c.predecessors[1] AS predecessor
    FROM capture_links c JOIN subjects root ON root.stable_id=c.original
    JOIN raw_nodes p ON p.stable_id=c.predecessors[1]
    WHERE len(c.predecessors)=1 AND c.original<>c.stable_id AND p.stable_id<>c.stable_id
      AND (p.stable_id=c.original OR (list_contains(p.labels,'CapturedBinding')
        AND json_extract_string(p.props_json,'$.originalStableId')=c.original))''')
db.execute('''CREATE TABLE capture_originals AS
    WITH RECURSIVE walk(stable_id,current,original,path) AS (
      SELECT stable_id,predecessor,original,[stable_id] FROM capture_edges
      UNION ALL
      SELECT w.stable_id,e.predecessor,w.original,list_append(w.path,w.current)
      FROM walk w JOIN capture_edges e ON e.stable_id=w.current AND e.original=w.original
      WHERE w.current<>w.original AND NOT list_contains(w.path,w.current)
    )
    SELECT w.stable_id,[e.predecessor] AS targets,w.original,w.path AS capture_path
    FROM walk w JOIN capture_edges e ON e.stable_id=w.stable_id WHERE w.current=w.original''')
db.execute('CREATE TABLE audit(stable_id VARCHAR,category VARCHAR,missing_step BOOLEAN,targets VARCHAR[])')
rows = []
for row in audit['subjects']:
    targets = sorted({edge['target'] for edge in row['outgoingEvidence']
        if (edge['relation']=='VALUE_FROM' or edge['relation']=='AST_CHILD' and edge['properties'].get('field')=='initializer')
        and edge['targetKind'] in ('ArrowFunction','FunctionExpression') and edge['targetBodyCount']>0})
    if row.get('proxyTarget'):
        targets = [row['proxyTarget']]
    rows.append((row['stable_id'],row['auditCategory'],any(not s['entryExists'] for s in row['ownedSteps']),targets))
if rows:
    db.executemany('INSERT INTO audit VALUES (?,?,?,?)', rows)
db.execute('''CREATE TABLE generic_context AS
    SELECT r.from_id AS stable_id,list(DISTINCT r.to_id ORDER BY r.to_id) AS targets
    FROM rels r JOIN subjects s ON s.stable_id=r.from_id JOIN subjects target ON target.stable_id=r.to_id
    WHERE list_contains(s.labels,'GenericUse') AND r.rel_type IN ('INSTANTIATES','TYPE_ARGUMENT')
      AND r.from_id<>r.to_id GROUP BY r.from_id''')

db.execute('''CREATE TABLE plan AS SELECT s.stable_id,
    CASE
      WHEN coalesce(a.missing_step,false) THEN 'blocked-missing-step-target'
      WHEN s.reason='resolved-source-occurrence' THEN 'follow-original'
      WHEN a.category='explicit-external-boundary' OR s.context_kind='external-catalog' THEN 'external-boundary'
      WHEN s.reason='source-file-ownership-boundary' THEN 'syntax-summary'
      WHEN s.reason='source-expansion-required' THEN 'deferred-source-expansion'
      WHEN a.category IN ('binding-to-confirmed-implementation','function-proxy-resolved-by-property') THEN 'follow-original'
      WHEN a.category='empty-body' THEN 'syntax-summary'
      WHEN a.category='signature-without-body' THEN 'contract-candidate'
      WHEN a.category='empty-body-with-parameter-properties' THEN 'generation-candidate'
      WHEN s.mode='reference' THEN 'follow-original'
      WHEN capture.stable_id IS NOT NULL THEN 'follow-original'
      WHEN s.reason='no-ownership-or-reference-evidence' AND object_arg.stable_id IS NOT NULL
        AND len(d.targets)=1 AND NOT d.invalid_target THEN 'compose-in-owner'
      WHEN s.reason='no-ownership-or-reference-evidence' AND object_arg.stable_id IS NOT NULL THEN 'review-owner'
      WHEN c.stable_id IS NOT NULL AND
        (s.mode='standalone' OR a.category='body-confirmed-through-entry') THEN 'compose-in-owner'
      WHEN list_contains(s.labels,'CallbackImplementation') AND s.body_count>0 AND
        (s.mode='standalone' OR a.category='body-confirmed-through-entry') THEN 'generation-candidate'
      WHEN list_contains(s.labels,'CallbackImplementation') AND
        (s.mode='standalone' OR a.category='body-confirmed-through-entry') THEN 'review-callback'
      WHEN s.mode='standalone' OR a.category='body-confirmed-through-entry' THEN 'generation-candidate'
      WHEN s.mode='inline' AND len(d.targets)=1 AND NOT d.invalid_target THEN 'compose-in-owner'
      WHEN s.mode='inline' THEN 'review-owner'
      ELSE 'blocked-unresolved' END AS decision,
    CASE WHEN s.reason='resolved-source-occurrence' THEN 'explicit-source-occurrence'
      WHEN capture.stable_id IS NOT NULL THEN 'explicit-capture-chain'
      WHEN object_arg.stable_id IS NOT NULL AND s.reason='no-ownership-or-reference-evidence' THEN 'explicit-object-argument'
      WHEN c.stable_id IS NOT NULL THEN 'direct-callback-argument'
      ELSE coalesce(a.category,s.reason) END AS evidence_reason,
    CASE WHEN s.reason='resolved-source-occurrence' THEN s.originals
      WHEN len(a.targets)>0 THEN a.targets WHEN s.mode='reference' THEN s.originals
      WHEN capture.stable_id IS NOT NULL THEN capture.targets
      WHEN object_arg.stable_id IS NOT NULL AND s.reason='no-ownership-or-reference-evidence' THEN d.targets
      WHEN s.mode='inline' OR list_contains(s.labels,'CallbackImplementation') THEN coalesce(d.targets,s.owners)
      ELSE []::VARCHAR[] END AS context_targets,
    d.evidence AS immediate_owner_evidence,
    coalesce(d.targets,[]::VARCHAR[]) AS immediate_owner_targets,
    capture.original AS capture_original,
    capture.capture_path AS capture_path,
    CASE WHEN d.invalid_target THEN 'invalid-direct-owner-target'
      WHEN len(d.targets)=1 THEN 'unique-direct-owner'
      WHEN len(d.targets)>1 THEN 'conflicting-direct-owners'
      ELSE 'no-direct-owner-evidence' END AS owner_status,
    s.body_targets AS required_body_context,
    coalesce(g.targets,[]::VARCHAR[]) AS required_type_context,
    coalesce(v.targets,[]::VARCHAR[]) AS required_value_context,
    coalesce(callable.targets,[]::VARCHAR[]) AS required_callable_context,
    s.reason='source-expansion-required' AS expansion_required,
    true AS retain_context,
    false AS scheduled
    FROM subjects s LEFT JOIN audit a USING(stable_id)
    LEFT JOIN direct_owners d USING(stable_id)
    LEFT JOIN callback_composition c USING(stable_id)
    LEFT JOIN capture_originals capture USING(stable_id)
    LEFT JOIN object_arguments object_arg USING(stable_id)
    LEFT JOIN generic_context g USING(stable_id)
    LEFT JOIN (SELECT r.from_id AS stable_id,list(DISTINCT r.to_id ORDER BY r.to_id) AS targets
      FROM rels r JOIN subjects target ON target.stable_id=r.to_id
      WHERE r.rel_type='CALLS_VALUE' AND r.from_id<>r.to_id
        AND json_extract_string(r.props_json,'$.resolution')='ast-computed-callee'
      GROUP BY r.from_id) callable USING(stable_id)
    LEFT JOIN (SELECT r.from_id AS stable_id,list(DISTINCT r.to_id ORDER BY r.to_id) AS targets
      FROM rels r JOIN subjects child ON child.stable_id=r.from_id
      JOIN subjects receiver ON receiver.stable_id=r.to_id
      WHERE r.from_id<>r.to_id AND (
        ((list_contains(child.labels,'DynamicMemberAccess')
          OR (list_contains(child.labels,'MemberReference')
            AND child.reason IN ('unresolved-reference','member-access-needs-receiver')))
          AND r.rel_type='READS_FROM'
          AND json_extract_string(r.props_json,'$.role')='receiver')
        OR (list_contains(child.labels,'ValueConsumption') AND r.rel_type='CONSUMES_VALUE'
          AND json_extract_string(r.props_json,'$.role') IN ('receiver','index'))
        OR (list_has_all(child.labels,['SyntaxContainer','System']) AND r.rel_type='CONSUMES_VALUE'
          AND json_extract_string(r.props_json,'$.role')='discarded'
          AND json_extract_string(r.props_json,'$.resolution')='ast-operand')
        OR (list_contains(child.labels,'GuardedGlobalAccess') AND child.reason='guarded-global-needs-context'
          AND ((r.rel_type='READS_FROM' AND json_extract_string(r.props_json,'$.resolution')='ast-guarded-global-receiver')
            OR (r.rel_type='GUARDED_BY' AND json_extract_string(r.props_json,'$.resolution')='ast-positive-in-guard')))
        OR (list_contains(child.labels,'GuardedRuntimeAccess') AND child.reason='guarded-runtime-needs-context'
          AND ((r.rel_type='GUARDED_BY' AND json_extract_string(r.props_json,'$.resolution')='ast-positive-typeof-guard')
            OR (r.rel_type='GUARD_VIA' AND json_extract_string(r.props_json,'$.resolution')='ast-unwritten-condition-binding')))
        OR (list_contains(child.labels,'CommonJsModuleRequest') AND child.reason='module-request-needs-specifier'
          AND r.rel_type='REQUESTS_MODULE' AND json_extract_string(r.props_json,'$.resolution')='ast-commonjs-module-specifier')
        OR (list_contains(child.labels,'HostRuntimeAccess') AND r.rel_type='HOSTED_BY'
          AND json_extract_string(r.props_json,'$.resolution')='typescript-standard-audioworklet-loader')
        OR (list_contains(child.labels,'NodeRuntimeAccess')
          AND ((r.rel_type='RUNTIME_GUARDED_BY' AND json_extract_string(r.props_json,'$.resolution')='ast-positive-node-version-guard')
            OR (r.rel_type='GUARD_VIA' AND json_extract_string(r.props_json,'$.resolution')='ast-unwritten-condition-binding')))
        OR (list_contains(child.labels,'ConditionalRuntimeCapture') AND child.reason='conditional-capture-needs-creation-context'
          AND ((r.rel_type='CREATED_UNDER' AND json_extract_string(r.props_json,'$.resolution')='ast-callback-creation-guard')
            OR (r.rel_type='CAPTURE_CONTEXT' AND json_extract_string(r.props_json,'$.resolution')='ast-inline-callback-context')
            OR (r.rel_type='GUARD_VIA' AND json_extract_string(r.props_json,'$.resolution')='ast-unwritten-condition-binding')))
        OR (list_contains(child.labels,'RuntimeThisBinding') AND r.rel_type='BOUND_TO_CONTEXT'
          AND json_extract_string(r.props_json,'$.resolution')='ast-this-binding'))
      GROUP BY r.from_id) v USING(stable_id)''')
assert db.execute('SELECT count(*) FROM plan').fetchone()[0] == summary['nodes']
assert db.execute("SELECT count(*) FROM plan WHERE decision='follow-original' AND len(context_targets)=0").fetchone()[0] == 0
assert db.execute("SELECT count(*) FROM plan WHERE decision='compose-in-owner' AND len(context_targets)<>1").fetchone()[0] == 0
destination = str(args.report/'annotation-plan.parquet').replace("'", "''")
db.execute(f"COPY plan TO '{destination}' (FORMAT PARQUET,COMPRESSION ZSTD)")
owner_review = []
for status, reason, count in db.execute('''SELECT owner_status,s.reason,count(*)
    FROM plan p JOIN subjects s USING(stable_id) WHERE decision='review-owner'
    GROUP BY owner_status,s.reason ORDER BY count(*) DESC''').fetchall():
    examples = db.execute('''SELECT p.stable_id,p.context_targets,p.immediate_owner_evidence
        FROM plan p JOIN subjects s USING(stable_id)
        WHERE decision='review-owner' AND owner_status=? AND s.reason=?
        ORDER BY p.stable_id LIMIT 3''', [status,reason]).fetchall()
    owner_review.append({'status':status,'reason':reason,'count':count,
        'examples':[{'stableId':i,'candidateOwners':t,'evidence':e} for i,t,e in examples]})
report = {'version':42,'nodes':summary['nodes'],
    'counts':dict(db.execute('SELECT decision,count(*) FROM plan GROUP BY decision ORDER BY decision').fetchall()),
    'source':'extraction-report-not-live-neo4j','provenanceIds':summary['provenanceIds'],
    'generatesAnnotations':False,'scheduledTasks':0,'requiredGenerationCount':None,
    'ownerReview':owner_review,
    'limitations':['Candidates require demand/reachability and annotation-freshness checks.',
        'Direct callback arguments compose into the call; their bodies remain required context, not separate scheduled jobs.',
        'Ownership without direct AST/immediate-step evidence remains under review.',
        'Multiple owners require resolution; no arbitrary owner is selected.',
        'Scoped Neo4j imports do not update this immutable extraction snapshot.']}
(args.report/'annotation-plan.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
db.close()
spill.cleanup()
