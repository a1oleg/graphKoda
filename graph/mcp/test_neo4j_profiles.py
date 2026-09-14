import os
import unittest
from unittest.mock import patch

from graph.mcp.neo4j_profiles import load_connection_settings, build_driver_kwargs, build_driver_uri


class AuraProfileTests(unittest.TestCase):
    def test_aura_uses_own_credentials_and_verified_routing(self):
        env = {'AURA_NEO4J_URI': 'neo4j+s://example.databases.neo4j.io',
               'AURA_NEO4J_USERNAME': 'cloud', 'AURA_NEO4J_PASSWORD': 'test',
               'NEO4J_URI': 'bolt://localhost:7687', 'NEO4J_PASSWORD': 'local'}
        with patch.dict(os.environ, env, clear=True), patch('graph.mcp.neo4j_profiles.load_dotenv'):
            settings = load_connection_settings('aura')
        self.assertEqual(build_driver_uri(settings), env['AURA_NEO4J_URI'])
        self.assertEqual(build_driver_kwargs(settings), {'auth': ('cloud', 'test')})

    def test_aura_does_not_fall_back_to_local(self):
        with patch.dict(os.environ, {'NEO4J_URI': 'bolt://localhost:7687'}, clear=True), patch('graph.mcp.neo4j_profiles.load_dotenv'):
            with self.assertRaisesRegex(RuntimeError, 'Missing required Aura'):
                load_connection_settings('aura')

    def test_aura_rejects_unverified_transport(self):
        env = {'AURA_NEO4J_URI': 'neo4j+ssc://example', 'AURA_NEO4J_USERNAME': 'cloud', 'AURA_NEO4J_PASSWORD': 'test'}
        with patch.dict(os.environ, env, clear=True), patch('graph.mcp.neo4j_profiles.load_dotenv'):
            with self.assertRaisesRegex(RuntimeError, 'verified TLS'):
                load_connection_settings('aura')
