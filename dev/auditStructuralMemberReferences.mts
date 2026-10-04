import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {createProgram} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import projectPaths from './projectPaths.cjs';
import {gitIdentity} from './extractionProvenance.mjs';

const snapshot = process.argv[2];
if (!snapshot) throw new Error('Usage: node --import tsx dev/auditStructuralMemberReferences.mts <actual-extraction-snapshot> [output-json]');
const instance = await DuckDBInstance.create(':memory:', {memory_limit: '1GB', threads: '1'});
const connection = await instance.connect();
try {
  const metadata = (await connection.runAndReadAll('SELECT metadata_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet', 'provenance.parquet')])).getRows();
  if (metadata.length !== 1) throw new Error('Expected one extraction provenance record');
  const extracted = JSON.parse(String(metadata[0][0]));
  const sourceIdentity = gitIdentity(projectPaths.sourceRoot);
  if (sourceIdentity.commit !== extracted.source_revision || sourceIdentity.dirtyFingerprint !== extracted.source_dirty_fingerprint) {
    throw new Error('Source checkout differs from extraction snapshot; source-shape comparison would be invalid');
  }
  const rows = (await connection.runAndReadAll(`SELECT s.stable_id,n.props_json
    FROM read_parquet(?) s JOIN read_parquet(?) p USING(stable_id) JOIN read_parquet(?) n USING(stable_id)
    WHERE p.decision='blocked-unresolved' AND s.reason='unresolved-reference'
      AND list_contains(s.labels,'MemberReference')`, [path.join(snapshot, 'inventory', 'subjects.parquet'),
      path.join(snapshot, 'inventory', 'annotation-plan.parquet'), path.join(snapshot, 'parquet', 'nodes.parquet')])).getRows();
  const program = createProgram();
  const checker = program.getTypeChecker();
  const requested = new Map<string, Map<number, {id: string; end: number}>>();
  const unmatched = new Set<string>();
  for (const [id, raw] of rows) {
    const props = JSON.parse(String(raw));
    unmatched.add(String(id));
    const file = program.getSourceFile(path.resolve(projectPaths.sourceRoot, props.repoRelativePath));
    if (!file) continue;
    let offsets = requested.get(file.fileName);
    if (!offsets) requested.set(file.fileName, offsets = new Map());
    offsets.set(file.getPositionOfLineAndCharacter(props.startLine - 1, props.startColumn), {
      id: String(id), end: file.getPositionOfLineAndCharacter(props.endLine - 1, props.endColumn),
    });
  }
  const counts: Record<string, number> = {};
  const examples: Record<string, unknown[]> = {};
  for (const [name, offsets] of requested) {
    const file = program.getSourceFile(name)!;
    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        const record = offsets.get(node.getStart(file));
        if (record && node.getEnd() === record.end) {
          unmatched.delete(record.id);
          const symbol = checker.getSymbolAtLocation(node);
          const declarations = symbol?.declarations || (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []);
          const receiver = node.parent.expression;
          const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
          const member = type.getProperty(node.text);
          const kind = declarations.length ? 'has-source-declaration'
            : type.flags & ts.TypeFlags.Any ? 'receiver-any'
            : checker.getIndexInfoOfType(type, ts.IndexKind.String) ? 'string-index-signature'
            : member ? 'structural-type-member' : 'missing-member-evidence';
          counts[kind] = (counts[kind] || 0) + 1;
          const group = examples[kind] ||= [];
          if (group.length < 4) group.push({stableId: record.id, receiver: receiver.getText(file),
            memberName: node.text, receiverType: checker.typeToString(type)});
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  const report = {input: snapshot, provenanceId: extracted.id, sourceIdentity, sourceIdentityConfirmed: true,
    candidates: rows.length, counts, unmatched: unmatched.size,
    examples, classificationOnly: true, fullGraphReextracted: false, writesNeo4j: false};
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'});
  console.log(JSON.stringify(report));
} finally {
  connection.closeSync();
  instance.closeSync();
}
