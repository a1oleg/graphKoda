import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { insertDrawioAnnotation, updateDrawioAnnotation } from '../orchestrator.js';

function fixtureXml() {
  return `<mxfile><diagram><mxGraphModel><root>
<mxCell id="0" />
<mxCell id="1" parent="0" />
<mxCell id="fold-layout-root" vertex="1" parent="1"><mxGeometry x="0" y="0" width="800" height="600" as="geometry" /></mxCell>
<mxCell id="fold-row-2" vertex="1" parent="fold-layout-root"><mxGeometry x="0" y="100" width="300" height="120" as="geometry" /></mxCell>
<mxCell id="target-group" vertex="1" parent="fold-row-2"><mxGeometry x="110" y="35" width="150" height="60" as="geometry" /></mxCell>
<mxCell id="target-part" stableId="fixture:parameter" vertex="1" parent="target-group"><mxGeometry x="0" y="0" width="55" height="40" as="geometry" /></mxCell>
<mxCell id="annotation-old" value="old" vertex="1" parent="target-group"><mxGeometry x="120" y="0" width="220" height="58" as="geometry" /></mxCell>
<mxCell id="annotation-old-edge" edge="1" parent="target-group" source="annotation-old" target="target-part"><mxGeometry relative="1" as="geometry" /></mxCell>
</root></mxGraphModel></diagram></mxfile>`;
}

function readCell(xml, id) {
  return xml.match(new RegExp(`<mxCell\\b[^>]*\\bid="${id}"[^>]*(?:/>|>[\\s\\S]*?</mxCell>)`))?.[0] || '';
}

function readWidth(cellXml) {
  return Number(cellXml.match(/<mxGeometry\b[^>]*\bwidth="([^"]+)"/)?.[1]);
}

function makeWorkspaceTempDir() {
  const root = path.join(process.cwd(), '.test-tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'annotation-drawio-'));
}

test('annotation expands its Step row and creates an initially hidden target edge', () => {
  const directory = makeWorkspaceTempDir();
  const diagramPath = path.join(directory, 'fixture.drawio');
  try {
    fs.writeFileSync(diagramPath, fixtureXml(), 'utf8');
    const first = insertDrawioAnnotation({
      diagramPath,
      element: { cellId: 'target-part' },
      annotationText: 'Описание параметра.',
      annotationMetadata: {
        toolGitCommitShortHash: 'abc123def456',
        maxDepth: 4,
      },
      replaceExistingForTarget: true,
    });
    const firstXml = fs.readFileSync(diagramPath, 'utf8');
    const firstStep = readCell(firstXml, 'fold-row-2');
    const firstAnnotation = readCell(firstXml, first.annotationId);
    const firstEdge = readCell(firstXml, first.edgeId);
    const firstWidth = readWidth(firstStep);

    assert.equal(first.stepRowId, 'fold-row-2');
    assert.equal(first.edgeId, `${first.annotationId}-link`);
    assert.ok(firstWidth > 300);
    assert.match(firstStep, /annotationBaseWidth="300"/);
    assert.match(firstAnnotation, /parent="fold-row-2"/);
    assert.match(firstAnnotation, /annotationTargetId="target-part"/);
    assert.match(firstAnnotation, /annotationToolGitCommitShortHash="abc123def456"/);
    assert.match(firstAnnotation, /annotationMaxDepth="4"/);
    assert.match(firstAnnotation, /annotationSavedText=/);
    assert.match(firstAnnotation, /editable=1/);
    assert.match(firstAnnotation, /fillColor=#f5f5f5;strokeColor=#b3b3b3/);
    assert.match(firstAnnotation, /fontSize=14/);
    assert.match(firstAnnotation, /whiteSpace=wrap;html=1;overflow=fill/);
    assert.match(firstAnnotation, /align=center/);
    assert.ok(Number(firstAnnotation.match(/<mxGeometry\b[^>]*\bx="([^"]+)"/)?.[1]) > 300);
    assert.ok(Number(firstAnnotation.match(/<mxGeometry\b[^>]*\bheight="([^"]+)"/)?.[1]) <= 112);
    assert.doesNotMatch(firstXml, /id="annotation-old(?:"|-edge")/);
    assert.match(firstEdge, /annotationLink="1"/);
    assert.match(firstEdge, /visible="0"/);
    assert.match(firstEdge, new RegExp(`source="${first.annotationId}"`));
    assert.match(firstEdge, /target="target-part"/);

    insertDrawioAnnotation({
      diagramPath,
      element: { cellId: 'target-part' },
      annotationText: 'Описание параметра.',
      replaceExistingForTarget: true,
    });
    const secondXml = fs.readFileSync(diagramPath, 'utf8');
    assert.equal(readWidth(readCell(secondXml, 'fold-row-2')), firstWidth);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('editing an annotation updates its displayed and cancellation baseline text', () => {
  const directory = makeWorkspaceTempDir();
  const diagramPath = path.join(directory, 'fixture.drawio');
  try {
    fs.writeFileSync(diagramPath, fixtureXml(), 'utf8');
    const inserted = insertDrawioAnnotation({
      diagramPath,
      element: { cellId: 'target-part' },
      annotationText: 'Initial annotation.',
    });
    const updated = updateDrawioAnnotation({
      diagramPath,
      annotationCellId: inserted.annotationId,
      annotationText: 'Edited annotation.',
    });
    const annotation = readCell(fs.readFileSync(diagramPath, 'utf8'), inserted.annotationId);

    assert.equal(updated.text, 'Edited annotation.');
    assert.equal(updated.targetId, 'target-part');
    assert.match(annotation, /value="Edited annotation\."/);
    assert.match(annotation, /annotationSavedText="Edited annotation\."/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('long annotation is widened until its compact height fits inside the Step row', () => {
  const directory = makeWorkspaceTempDir();
  const diagramPath = path.join(directory, 'fixture.drawio');
  try {
    fs.writeFileSync(diagramPath, fixtureXml(), 'utf8');
    const result = insertDrawioAnnotation({
      diagramPath,
      element: { cellId: 'target-part' },
      annotationText: 'Вызывает повторное закрепление области вывода у нижней границы со сбросом индекса полноэкранного разделителя и сохранённого положения курсора.',
      replaceExistingForTarget: true,
    });
    const xml = fs.readFileSync(diagramPath, 'utf8');
    const annotation = readCell(xml, result.annotationId);
    const height = Number(annotation.match(/<mxGeometry\b[^>]*\bheight="([^"]+)"/)?.[1]);
    const y = Number(annotation.match(/<mxGeometry\b[^>]*\by="([^"]+)"/)?.[1]);

    assert.ok(height <= 72);
    assert.ok(y + height <= 116);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
