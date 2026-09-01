import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name('fromPreGraphToNeo4j.py')
SPEC = importlib.util.spec_from_file_location('fromPreGraphToNeo4j', MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
normalize_function = MODULE.normalize_function
normalize_node = MODULE.normalize_node
normalize_edge = MODULE.normalize_edge
parse_args = MODULE.parse_args
clear_scoped_flow = MODULE.clear_scoped_flow
clear_replaced_semantic_relationships = MODULE.clear_replaced_semantic_relationships
restore_scoped_annotations = MODULE.restore_scoped_annotations


class FakeResult:
    def __init__(self, row: dict[str, int] | None = None) -> None:
        self.row = row

    def single(self) -> dict[str, int] | None:
        return self.row

    def consume(self) -> None:
        return None


class FakeSession:
    def __init__(self, rows: list[dict[str, int] | None]) -> None:
        self.rows = list(rows)
        self.calls: list[tuple[str, dict[str, str]]] = []

    def run(self, query: str, **params: str) -> FakeResult:
        self.calls.append((query, params))
        row = self.rows.pop(0) if self.rows else None
        return FakeResult(row)


class WriterTransportContractTest(unittest.TestCase):
    def test_full_import_clears_neo4j_only_after_successful_extraction_by_default(self) -> None:
        args = parse_args(['func'])

        self.assertEqual(args.neo4j_clear_timing, 'after-extract')

    def test_scoped_import_preserves_annotations_by_default(self) -> None:
        args = parse_args(['func', '--fn-stable-id', 'app.ts:1:0:2:1'])

        self.assertTrue(args.preserve_annotations)

    def test_scoped_import_can_explicitly_replace_annotations(self) -> None:
        args = parse_args([
            'func',
            '--fn-stable-id',
            'app.ts:1:0:2:1',
            '--no-preserve-annotations',
        ])

        self.assertFalse(args.preserve_annotations)

    def test_scoped_cleanup_keeps_annotation_nodes_by_default(self) -> None:
        session = FakeSession([None, None])

        deleted = clear_scoped_flow(session, 'app.ts:1:0:2:1')

        self.assertEqual(deleted, 0)
        self.assertEqual(len(session.calls), 2)
        self.assertIn('MATCH (:Fn {stableId: $fnStableId})-[rel:HAS_OPERATION]', session.calls[0][0])
        self.assertNotIn('Annotation', session.calls[1][0])
        self.assertIn('n.repoRelativePath = $scopePath', session.calls[1][0])
        self.assertEqual(session.calls[1][1]['scopePath'], 'app.ts')

    def test_scoped_annotations_are_reattached_by_head_id(self) -> None:
        session = FakeSession([{'restored': 2}])

        restored = restore_scoped_annotations(session, 'app.ts:1:0:2:1')

        self.assertEqual(restored, 2)
        query, params = session.calls[0]
        self.assertIn('MATCH (head {stableId: annotation.headID})', query)
        self.assertIn('MERGE (head)-[:HAS_ANNOTATION]->(annotation)', query)
        self.assertEqual(params['fnStableId'], 'app.ts:1:0:2:1')

    def test_scoped_semantic_cleanup_replaces_outgoing_relation_types(self) -> None:
        session = FakeSession([None, None])

        clear_replaced_semantic_relationships(session, {
            'semanticRelationships': [
                {'fromId': 'ref', 'toId': 'old', 'type': 'RESOLVES_TO', 'props': {}},
                {'fromId': 'ref', 'toId': 'new', 'type': 'RESOLVES_TO', 'props': {}},
            ],
        })

        self.assertEqual(len(session.calls), 2)
        self.assertIn('type(rel) IN replacementTypes', session.calls[0][0])
        self.assertEqual(session.calls[0][1]['typesBySource'], {'ref': ['RESOLVES_TO']})
        self.assertIn("declarationKind: 'ShorthandPropertyAssignment'", session.calls[1][0])

    def test_writer_does_not_infer_external_label(self) -> None:
        row = normalize_function({
            'stableId': 'external:feature',
            'labels': ['Callable'],
            'props': {
                'name': 'feature',
                'is_external': True,
            },
        })

        self.assertEqual(row['labels'], ['Callable'])

    def test_writer_requires_flat_ts_transport_ids(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'non-empty string prepared by the TS extractor'):
            normalize_node({
                'stableId': {'value': 'app.ts:1:0:1:1'},
                'labels': ['Read'],
                'props': {},
            })

    def test_writer_preserves_ts_label_order(self) -> None:
        row = normalize_node({
            'stableId': 'app.ts:1:0:1:1',
            'labels': ['Arg', 'Branch'],
            'props': {},
        })

        self.assertEqual(row['labels'], ['Arg', 'Branch'])

    def test_writer_marks_canonical_annotation_subjects(self) -> None:
        row = normalize_node({
            'stableId': 'app.ts:1:0:1:1',
            'labels': ['ValueSlot'],
            'props': {'annotationKind': 'Binding'},
        })

        self.assertEqual(row['labels'], ['ValueSlot', 'Annotatable'])

    def test_writer_marks_annotation_proxies_without_marking_them_annotatable(self) -> None:
        row = normalize_node({
            'stableId': 'app.ts:2:0:2:5',
            'labels': ['ValueAccess', 'VisualProxy'],
            'props': {
                'annotationKind': 'ValueUse',
                'canonicalStableId': 'app.ts:1:0:1:1',
            },
        })

        self.assertEqual(row['labels'], ['ValueAccess', 'VisualProxy', 'AnnotationProxy'])
        self.assertNotIn('Annotatable', row['labels'])

    def test_writer_requires_canonical_props_from_ts(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'props must be an object prepared by the TS extractor'):
            normalize_node({
                'stableId': 'app.ts:1:0:1:1',
                'labels': ['Anything'],
            })

    def test_writer_rejects_stable_id_duplicated_inside_props(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'must not duplicate'):
            normalize_node({
                'stableId': 'app.ts:1:0:1:1',
                'labels': ['Anything'],
                'props': {'stableId': 'app.ts:1:0:1:1'},
            })

    def test_writer_does_not_classify_relationship_types(self) -> None:
        row = normalize_edge({
            'fromId': 'left',
            'toId': 'right',
            'type': 'domain relation',
            'props': {'display_label': 'domain relation'},
        })

        self.assertEqual(row['type'], 'domain relation')


if __name__ == '__main__':
    unittest.main()
