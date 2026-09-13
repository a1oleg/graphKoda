import fs from 'node:fs';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';

export const fisherYatesRoot = 'examples/fisher-yates/src/shuffle.ts:1:7:11:1';
export const fisherYatesScope = 'fisher-yates';
export function auraConnection() {
  const env = dotenv.parse(fs.readFileSync(new URL('../graph/.env', import.meta.url)));
  if (!env.AURA_NEO4J_URI || !env.AURA_NEO4J_PASSWORD) throw new Error('Configure AURA_NEO4J_* in graph/.env');
  const driver = neo4j.driver(env.AURA_NEO4J_URI, neo4j.auth.basic(env.AURA_NEO4J_USERNAME || 'neo4j', env.AURA_NEO4J_PASSWORD));
  const database = env.AURA_NEO4J_DATABASE || 'neo4j';
  return { driver, database, session: driver.session({ database }) };
}
