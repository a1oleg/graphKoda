import unittest
from unittest.mock import Mock
from extraction_provenance import validate_provenance, check_scoped_provenance, register_provenance


def passport():
    return dict(id='a'*64, extractor_commit='b'*40, source_revision='c'*40,
                extractor_dirty_fingerprint=None, source_dirty_fingerprint=None, extracted_at='2026-09-09T00:00:00Z')


class ProvenanceTests(unittest.TestCase):
    def test_legacy_payload_is_rejected_before_any_query(self):
        session=Mock()
        with self.assertRaises(ValueError): check_scoped_provenance(session, {})
        session.run.assert_not_called()

    def test_inconsistent_fact_is_rejected(self):
        session=Mock()
        with self.assertRaises(ValueError):
            check_scoped_provenance(session, {'provenance':passport(),'nodes':[{'stableId':'node','props':{}}]})
        session.run.assert_not_called()

    def test_conflicting_existing_fact_is_rejected_without_writes(self):
        session=Mock();session.run.return_value.single.return_value={'stableId':'node'}
        with self.assertRaisesRegex(ValueError, 'conflict'):
            check_scoped_provenance(session, {'provenance':passport(),'nodes':[{'stableId':'node','props':{'provenance_id':'a'*64}}]})
        self.assertNotIn('SET',session.run.call_args.args[0])

    def test_valid_metadata_is_registered_without_using_importer_git_version(self):
        session=Mock();register_provenance(session,[passport()])
        self.assertEqual(session.run.call_args.kwargs['records'][0]['extractor_commit'],'b'*40)

    def test_unknown_source_version_is_rejected(self):
        record=passport();record['source_revision']='unknown'
        with self.assertRaises(ValueError): validate_provenance(record)


if __name__=='__main__': unittest.main()
