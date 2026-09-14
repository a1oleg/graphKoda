from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
import neo4j
from neo4j import GraphDatabase


ENV_PATH = Path(__file__).resolve().parent.parent / '.env'
SUPPORTED_PROFILES = ('local', 'aura')


def load_connection_settings(profile: str = 'local') -> dict[str, str]:
    if profile not in SUPPORTED_PROFILES:
        raise RuntimeError(f"Unsupported Neo4j profile: {profile}")

    load_dotenv(ENV_PATH)

    if profile == 'aura':
        settings = {
            'uri': os.getenv('AURA_NEO4J_URI') or '',
            'username': os.getenv('AURA_NEO4J_USERNAME') or os.getenv('AURA_NEO4J_USER') or '',
            'password': os.getenv('AURA_NEO4J_PASSWORD') or '',
            'database': os.getenv('AURA_NEO4J_DATABASE') or 'neo4j',
            'profile': profile,
            'trust_mode': 'system',
            'ca_cert_file': '',
        }
        missing = [key for key in ('uri', 'username', 'password') if not settings[key]]
        if missing:
            raise RuntimeError(f"Missing required Aura settings: {', '.join(missing)}")
        if not settings['uri'].startswith('neo4j+s://'):
            raise RuntimeError('Aura requires a neo4j+s:// URI with verified TLS.')
        return settings

    uri = os.getenv('NEO4J_URI')
    username = os.getenv('NEO4J_USER') or os.getenv('NEO4J_USERNAME')
    password = os.getenv('NEO4J_PASSWORD')
    database = os.getenv('NEO4J_DATABASE') or os.getenv('NEO4J_DB') or 'neo4j'
    trust_mode = (os.getenv('NEO4J_TRUST_MODE') or 'system').strip().lower()
    ca_cert_file = os.getenv('NEO4J_CA_CERT_FILE')
    missing_names = {
        'NEO4J_URI': uri,
        'NEO4J_USER/NEO4J_USERNAME': username,
        'NEO4J_PASSWORD': password,
    }

    missing = [
        name
        for name, value in missing_names.items()
        if not value
    ]
    if missing:
        raise RuntimeError(f"Missing required local Neo4j settings: {', '.join(missing)}")

    if trust_mode == 'custom' and not ca_cert_file:
        raise RuntimeError('Missing required local CA certificate setting for custom trust mode.')

    return {
        'uri': uri,
        'username': username,
        'password': password,
        'database': database,
        'profile': profile,
        'trust_mode': trust_mode,
        'ca_cert_file': ca_cert_file or '',
    }


def build_driver_kwargs(settings: dict[str, str]) -> dict[str, Any]:
    trust_mode = settings.get('trust_mode', 'system')
    kwargs: dict[str, Any] = {
        'auth': (settings['username'], settings['password']),
    }
    if settings.get('profile') == 'aura':
        # The +s URI configures TLS and certificate verification in the driver.
        return kwargs

    if trust_mode == 'all':
        if not settings['uri'].startswith(('neo4j+s://', 'bolt+s://')):
            kwargs['trusted_certificates'] = neo4j.TrustAll()
    elif trust_mode == 'system':
        kwargs['trusted_certificates'] = neo4j.TrustSystemCAs()
    elif trust_mode == 'custom':
        kwargs['encrypted'] = True
        kwargs['trusted_certificates'] = neo4j.TrustCustomCAs(
            Path(settings['ca_cert_file']).resolve().as_posix(),
        )
    elif trust_mode:
        raise RuntimeError(f"Unsupported {settings['profile']} trust mode: {trust_mode}")

    return kwargs


def build_driver_uri(settings: dict[str, str]) -> str:
    uri = settings['uri']
    profile = settings.get('profile', 'local')
    trust_mode = settings.get('trust_mode', 'system')

    # Local single-instance Neo4j commonly exposes a direct Bolt endpoint but not
    # a usable routing table, so prefer direct transport for the local MCP profile.
    if profile == 'local':
        if uri.startswith('neo4j+s://'):
            return uri.replace('neo4j+s://', 'bolt+s://', 1)
        if uri.startswith('neo4j+ssc://'):
            return uri.replace('neo4j+ssc://', 'bolt+ssc://', 1)
        if uri.startswith('neo4j://'):
            return uri.replace('neo4j://', 'bolt://', 1)

    if trust_mode == 'custom':
        if uri.startswith('neo4j+s://'):
            return uri.replace('neo4j+s://', 'bolt://', 1)
        if uri.startswith('neo4j://'):
            return uri.replace('neo4j://', 'bolt://', 1)
        if uri.startswith('bolt+s://'):
            return uri.replace('bolt+s://', 'bolt://', 1)

    if trust_mode != 'all':
        return uri

    if uri.startswith('neo4j+s://'):
        return uri.replace('neo4j+s://', 'neo4j+ssc://', 1)
    if uri.startswith('bolt+s://'):
        return uri.replace('bolt+s://', 'bolt+ssc://', 1)

    return uri


def create_driver(profile: str = 'local') -> tuple[dict[str, str], Any]:
    settings = load_connection_settings(profile)
    driver = GraphDatabase.driver(
        build_driver_uri(settings),
        **build_driver_kwargs(settings),
    )
    return settings, driver
