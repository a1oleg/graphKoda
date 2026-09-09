import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { collectCanonicalReferenceGraph } from './functionFlowGraph.canonicalReferences.ts';
import { extractFunctionFlowGraphs } from './fromASTtoPreGraphFlow.ts';
import { inferAnnotationKind } from '../../packages/orchestrator/src/orchestrator/annotationProfiles.js';

test('callable type signatures remain types even when used as call and constructor targets', () => {
  const dir = fs.mkdtempSync(path.resolve('tmp', 'signature-boundary-'));
  const file = path.join(dir, 'subject.ts');
  const ambient = path.join(dir, 'external.d.ts');
  fs.writeFileSync(ambient, 'export declare const external: (value: string) => number;');
  fs.writeFileSync(file, `
import { external } from './external.js';
export function subject(callback: (value: string) => number, factory: new () => object) {
  external('value');
  callback('value');
  return new factory();
}
`);
  try {
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true });
    const canonical = collectCanonicalReferenceGraph(program);
    const signatures = canonical.entities.filter(n => ['FunctionType', 'ConstructorType'].includes(String(n.props.declarationKind)) && !n.labels.includes('ExternalDeclaration'));
    assert.equal(signatures.length, 2);
    for (const signature of signatures) {
      assert.ok(signature.labels.includes('TypeDeclaration'));
      assert.ok(signature.labels.includes('DeveloperDefined'));
      assert.ok(!signature.labels.includes('ValueDeclaration'));
      assert.ok(!signature.labels.includes('CallableDeclaration'));
      assert.equal(inferAnnotationKind(signature.labels), null);
    }
    const externalSignatures = canonical.entities.filter(n => n.props.declarationKind === 'FunctionType' && n.labels.includes('ExternalDeclaration'));
    assert.equal(externalSignatures.length, 1);
    assert.ok(externalSignatures[0].labels.includes('System'));
    assert.ok(!externalSignatures[0].labels.includes('DeveloperDefined'));
    assert.equal(inferAnnotationKind(externalSignatures[0].labels), null);
    const flow = extractFunctionFlowGraphs(program);
    const serialized = JSON.stringify(flow);
    assert.ok(serialized.includes('DeveloperDefined'));
    // Check every visual tile, not only the canonical declaration.
    let tiles = 0;
    function check(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>;
      if (typeof row.renderPartsJson === 'string') check(JSON.parse(row.renderPartsJson));
      const text = String(row.text || row.syntax || row.actionTextRaw || '');
      if (Array.isArray(row.labels) && row.labels.includes('Type')
        && (text === '(value: string) => number' || text === 'new () => object')) {
        tiles++;
        assert.ok(!row.labels.includes('System'), text);
        assert.ok(row.labels.includes('DeveloperDefined'), text);
      }
      for (const child of Object.values(row)) check(child);
    }
    check(flow);
    assert.ok(tiles >= 2, 'both parameter type tiles must be checked');
  } finally {
    fs.rmSync(ambient);
    fs.rmSync(file);
    fs.rmdirSync(dir);
  }
});
