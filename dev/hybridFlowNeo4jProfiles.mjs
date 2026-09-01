import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';

const workspaceRoot = process.cwd();

function normalizeNeo4jUri(uri) {
  return String(uri || 'neo4j://127.0.0.1:7687')
    .replace('neo4j://localhost', 'bolt://localhost')
    .replace('neo4j://127.0.0.1', 'bolt://127.0.0.1');
}

function readProfile(envPath) {
  const absolutePath = path.resolve(workspaceRoot, envPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Neo4j profile does not exist: ${absolutePath}`);
  }
  const env = dotenv.parse(fs.readFileSync(absolutePath));
  const uri = normalizeNeo4jUri(env.NEO4J_URI || env.GRAPH_NEO4J_URI);
  const user = env.NEO4J_USERNAME || env.NEO4J_USER || 'neo4j';
  const password = env.NEO4J_PASSWORD || '';
  const database = env.NEO4J_DATABASE || env.NEO4J_DB || 'neo4j';
  if (!uri || !user || !password || !database) {
    throw new Error(`Incomplete Neo4j profile: ${absolutePath}`);
  }
  return {
    envPath: absolutePath,
    uri,
    user,
    password,
    database,
    auraInstanceId: env.AURA_INSTANCEID || '',
  };
}

export function loadGoldenAuraProfile(envPath = path.join('graph', '.env.aura')) {
  const profile = readProfile(envPath);
  const parsedUri = new URL(profile.uri);
  const expectedInstanceId = profile.auraInstanceId || 'cc5910ec';
  const isEncryptedAura = parsedUri.protocol === 'neo4j+s:' || parsedUri.protocol === 'neo4j+ssc:';
  if (!isEncryptedAura || !parsedUri.hostname.startsWith(`${expectedInstanceId}.`)) {
    throw new Error(
      `Golden profile must target Aura instance ${expectedInstanceId}; got ${parsedUri.protocol}//${parsedUri.hostname}`,
    );
  }
  return profile;
}

export function loadActualGraphProfile(envPath = path.join('graph', '.env')) {
  return readProfile(envPath);
}

export function createNeo4jDriver(profile) {
  return neo4j.driver(
    profile.uri,
    neo4j.auth.basic(profile.user, profile.password),
  );
}

export function describeNeo4jProfile(profile) {
  const parsedUri = new URL(profile.uri);
  return {
    host: parsedUri.hostname,
    database: profile.database,
    envPath: path.relative(workspaceRoot, profile.envPath).replaceAll('\\', '/'),
  };
}
