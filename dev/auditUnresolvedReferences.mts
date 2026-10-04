import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {createProgram, getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import projectPaths from './projectPaths.cjs';
import {gitIdentity} from './extractionProvenance.mjs';

const [snapshot, output, inventory = snapshot && path.join(snapshot, 'inventory')] = process.argv.slice(2);
if (!snapshot) throw new Error('Usage: <snapshot> [new-output-json]');
const instance = await DuckDBInstance.create(':memory:', {memory_limit: '1GB', threads: '1'});
const db = await instance.connect();
try {
  const metadata = JSON.parse(String((await db.runAndReadAll('SELECT metadata_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/provenance.parquet')])).getRows()[0][0]));
  const sourceIdentity = gitIdentity(projectPaths.sourceRoot);
  assert.equal(sourceIdentity.commit, metadata.source_revision, 'Source revision differs from extraction');
  assert.equal(sourceIdentity.dirtyFingerprint, metadata.source_dirty_fingerprint, 'Source changes differ from extraction');
  const requested = new Map((await db.runAndReadAll("SELECT n.stable_id,n.props_json FROM read_parquet(?) n JOIN read_parquet(?) p USING(stable_id) WHERE p.decision='blocked-unresolved'",
    [path.join(snapshot, 'parquet/nodes.parquet'), path.join(inventory!, 'annotation-plan.parquet')])).getRows()
    .map(([id, raw]) => [String(id), JSON.parse(String(raw))]));
  const program = createProgram(), checker = program.getTypeChecker();
  const records: Array<Record<string, unknown> & {stableId: string; category: string}> = [];
  for (const relative of new Set([...requested.values()].map(props => props.repoRelativePath))) {
    const source = program.getSourceFile(path.resolve(projectPaths.sourceRoot, relative));
    assert.ok(source, `Source absent from compiler program: ${relative}`);
    function visit(node: ts.Node) {
      const id = getExtendedStableId(source!, node);
      if (requested.has(id)) {
        const symbol = checker.getSymbolAtLocation(node);
        const alias = symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : undefined;
        const declarations = symbol?.declarations || (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []);
        const targets = alias?.declarations || (alias?.valueDeclaration ? [alias.valueDeclaration] : []);
        let category = declarations.length ? 'source-declaration-not-linked'
          : symbol ? 'compiler-symbol-without-declaration' : 'unbound-identifier';
        const evidence: Record<string, unknown> = {};
        if (ts.isIdentifier(node) && !symbol && ts.isExternalModule(source!)
          && ['__dirname', '__filename', 'require', 'exports', 'module'].includes(node.text)) {
          category = 'commonjs-binding-in-es-module';
          Object.assign(evidence, {requiredRuntimeScope: 'CommonJS module',
            runtimeContractUrl: 'https://nodejs.org/api/modules.html#the-module-wrapper',
            runtimeInjection: 'not-proven'});
        }
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
          const receiver = node.parent.expression;
          const type = checker.getTypeAtLocation(receiver);
          const nonNullable = checker.getNonNullableType(type);
          const member = nonNullable.getProperty(node.getText(source));
          const memberDeclarations = member?.declarations || (member?.valueDeclaration ? [member.valueDeclaration] : []);
          category = declarations.length || memberDeclarations.length ? 'member-declaration-not-linked'
            : nonNullable.flags & ts.TypeFlags.Never ? 'receiver-type-never'
            : nonNullable.flags & ts.TypeFlags.Any ? 'receiver-type-any'
            : checker.getIndexInfoOfType(nonNullable, ts.IndexKind.String) ? 'receiver-index-signature'
            : member ? 'member-without-source-declaration' : 'member-absent-from-receiver-type';
          Object.assign(evidence, {receiverSyntax: receiver.getText(source), receiverSyntaxKind: ts.SyntaxKind[receiver.kind],
            receiverType: checker.typeToString(type), nonNullableReceiverType: checker.typeToString(nonNullable),
            receiverTypeFlags: type.flags, memberDeclarationIds: memberDeclarations.map(declaration =>
              getExtendedStableId(declaration.getSourceFile(), declaration))});
        } else if (alias && !targets.length && declarations.length) category = 'unresolved-alias-with-local-binding';
        records.push({stableId: id, category, syntax: node.getText(source), syntaxKind: ts.SyntaxKind[node.kind],
          parentSyntaxKind: ts.SyntaxKind[node.parent.kind], compilerSymbolFlags: symbol?.flags,
          sourceModuleKind: ts.isExternalModule(source!) ? 'es-module' : 'script',
          sourceFile: source!.fileName, sourceStart: node.getStart(source), sourceEnd: node.end,
          declarationIds: declarations.map(declaration => getExtendedStableId(declaration.getSourceFile(), declaration)),
          aliasTargetDeclarationIds: targets.map(declaration => getExtendedStableId(declaration.getSourceFile(), declaration)),
          ...evidence});
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.equal(new Set(records.map(record => record.stableId)).size, requested.size, 'Not every unresolved graph coordinate matched AST');
  const options = program.getCompilerOptions();
  const jsRecords = records.filter(record => /\.(?:[cm]?js|jsx)$/i.test(String(record.sourceFile)));
  // checkJs may be disabled in the project. Diagnose the same sources separately,
  // without changing extraction options or treating missing names as resolved.
  const diagnosticProgram = jsRecords.length && !options.checkJs ? ts.createProgram({
    rootNames: program.getRootFileNames(), options: {...options, checkJs: true, noEmit: true}, oldProgram: program,
  }) : program;
  const diagnosticsByFile = new Map<string, readonly ts.Diagnostic[]>();
  for (const record of records) {
    const sourceFile = String(record.sourceFile);
    if (!diagnosticsByFile.has(sourceFile)) {
      const source = diagnosticProgram.getSourceFile(sourceFile)!;
      diagnosticsByFile.set(sourceFile, diagnosticProgram.getSemanticDiagnostics(source));
    }
    record.compilerDiagnostics = diagnosticsByFile.get(sourceFile)!.filter(diagnostic => diagnostic.start !== undefined
      && diagnostic.start < Number(record.sourceEnd)
      && diagnostic.start + (diagnostic.length || 1) > Number(record.sourceStart)).map(diagnostic => ({
        code: diagnostic.code, category: ts.DiagnosticCategory[diagnostic.category],
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        start: diagnostic.start, length: diagnostic.length,
      }));
  }
  records.sort((a, b) => a.stableId.localeCompare(b.stableId));
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.category] = (counts[record.category] || 0) + 1;
  const report = {version: 2, input: snapshot, provenanceId: metadata.id, sourceIdentity,
    sourceIdentityConfirmed: true, nodes: records.length, counts,
    compilerOptions: {allowJs: options.allowJs === true, checkJs: options.checkJs === true,
      types: options.types ?? null, strictNullChecks: options.strictNullChecks === true},
    diagnosticOptions: {checkJs: diagnosticProgram.getCompilerOptions().checkJs === true,
      separateFromExtraction: diagnosticProgram !== program},
    declaredButUnlinkedReferences: records.filter(record => ['source-declaration-not-linked',
      'member-declaration-not-linked'].includes(record.category)).length,
    unboundSourceReferences: records.filter(record => ['unbound-identifier',
      'commonjs-binding-in-es-module'].includes(record.category)).length,
    records, classificationOnly: true, generatesAnnotations: false, writesGraph: false,
    limitations: ['Unbound names are not automatically system globals.',
      'Never/any receiver types do not prove a member definition or runtime reachability.',
      'Compiler missing-name diagnostics do not rule out runtime injection by a host or bundler.']};
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'});
  console.log(JSON.stringify({...report, records: undefined, output: output || null}));
} finally { db.closeSync(); instance.closeSync(); }
