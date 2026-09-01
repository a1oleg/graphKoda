const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DIAGRAM_OUTPUT_RELATIVE_DIR,
  diagramFileName,
  diagramFilePath,
  diagramLabelSlug,
  diagramSourceCoordinate,
  ensureDiagramFile,
} = require('./diagramFiles');

test('all generated diagrams use the single standardized output directory', () => {
  const output = diagramFilePath('C:\\repo', {
    kind: 'flow',
    functionStableId: 'screens/REPL.tsx:3208:40:3278:9',
    label: 'executeImmediateCommand',
  });
  assert.equal(path.dirname(output), path.join(path.resolve('C:\\repo'), DIAGRAM_OUTPUT_RELATIVE_DIR));
});

test('diagram names use function, source file, and start line', () => {
  const descriptor = {
    functionStableId: 'screens/REPL.tsx:3208:40:3278:9',
    label: 'Fn executeImmediateCommand()',
  };
  assert.equal(diagramLabelSlug(descriptor.label), 'executeImmediateCommand');
  assert.deepEqual(diagramSourceCoordinate(descriptor.functionStableId), {
    fileName: 'REPL.tsx',
    startLine: 3208,
  });
  assert.equal(diagramFileName({ ...descriptor, kind: 'flow' }), 'executeImmediateCommand-REPL.tsx-3208.drawio');
  assert.equal(diagramFileName({ ...descriptor, kind: 'sequence' }), 'executeImmediateCommand-REPL.tsx-3208-sequence.drawio');
  assert.equal(diagramFileName({ ...descriptor, kind: 'functional-segment' }), 'executeImmediateCommand-REPL.tsx-3208-functional-segment.drawio');
  assert.notEqual(
    diagramFileName({ ...descriptor, kind: 'flow' }),
    diagramFileName({ ...descriptor, kind: 'sequence' }),
  );
});

test('the original onSubmit naming format is preserved', () => {
  assert.equal(diagramFileName({
    kind: 'flow',
    functionStableId: 'screens/REPL.tsx:3142:31:3533:3',
    label: 'onSubmit',
  }), 'onSubmit-REPL.tsx-3142.drawio');
});

test('invalid kinds and missing stable IDs are rejected', () => {
  assert.throws(() => diagramFileName({ kind: 'page', functionStableId: 'fn', label: 'subject' }));
  assert.throws(() => diagramFileName({ kind: 'flow', functionStableId: '', label: 'subject' }));
});

test('an existing diagram is refreshed so graph changes are materialized', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-files-'));
  const descriptor = { kind: 'flow', functionStableId: 'fixture:function', label: 'subject' };
  let renderCount = 0;
  try {
    const first = await ensureDiagramFile(workspaceRoot, descriptor, async (outputPath) => {
      renderCount += 1;
      fs.writeFileSync(outputPath, '<mxfile/>', 'utf8');
    });
    const second = await ensureDiagramFile(workspaceRoot, descriptor, async () => {
      renderCount += 1;
      fs.writeFileSync(first.filePath, '<mxfile revision="2"/>', 'utf8');
    });
    assert.equal(first.reused, false);
    assert.equal(first.refreshed, false);
    assert.equal(second.reused, false);
    assert.equal(second.refreshed, true);
    assert.equal(second.filePath, first.filePath);
    assert.equal(renderCount, 2);
    assert.equal(fs.readFileSync(second.filePath, 'utf8'), '<mxfile revision="2"/>');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('concurrent requests share one render', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-files-'));
  const descriptor = { kind: 'sequence', functionStableId: 'fixture:function', label: 'subject' };
  let renderCount = 0;
  try {
    const render = async (outputPath) => {
      renderCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      fs.writeFileSync(outputPath, '<mxfile/>', 'utf8');
    };
    const [first, second] = await Promise.all([
      ensureDiagramFile(workspaceRoot, descriptor, render),
      ensureDiagramFile(workspaceRoot, descriptor, render),
    ]);
    assert.equal(first.filePath, second.filePath);
    assert.equal(renderCount, 1);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
