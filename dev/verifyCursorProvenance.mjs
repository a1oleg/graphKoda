import assert from 'node:assert/strict';
import { config } from 'dotenv';
import neo4j from 'neo4j-driver';

// Read-only smoke checks for the cursor provenance extraction regression.
config({ path: 'graph/.env', quiet: true });
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(
  process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD,
));
const session = driver.session({ database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', defaultAccessMode: 'READ' });
try {
  const props = await session.run(`
    MATCH (call {stableId:$call})-[:HAS_ARGUMENT]->(props)-[:BINDS_TO_PARAMETER]->(parameter {stableId:$parameter})
    MATCH (props)-[:SPREADS_FROM]->(spread)-[:VALUE_FROM]->(reference)-[:RESOLVES_TO]->(source {stableId:$source})
    RETURN props.stableId AS props, parameter.stableId AS parameter, source.stableId AS source`, {
    call: 'components/PromptInput/PromptInput.tsx:2243:130:2243:158',
    parameter: 'components/TextInput.tsx:37:34:37:46',
    source: 'components/PromptInput/PromptInput.tsx:2172:8:2213:3',
  });
  assert.equal(props.records.length, 1, 'JSX spread does not reach the concrete props parameter');
  const context = await session.run(`
    MATCH (read {stableId:$read})-[:READS_CONTEXT]->(reference)-[:RESOLVES_TO]->(context)
      <-[:PROVIDES_CONTEXT]-(provided {stableId:$provided})-[:VALUE_FROM]->(value)
    RETURN context.stableId AS context, provided.stableId AS provided, value.stableId AS value`, {
    read: 'ink/hooks/use-declared-cursor.ts:34:31:34:67',
    provided: 'ink/components/App.tsx:172:51:172:103',
  });
  assert.equal(context.records.length, 1, 'Context read does not reach the provided value');
  const owner = await session.run(`
    MATCH (call {stableId:$call})-[:ENCLOSED_BY]->(owner {stableId:$owner})
    RETURN owner.stableId AS owner`, {
    call: 'components/BaseTextInput.tsx:53:20:53:41',
    owner: 'components/BaseTextInput.tsx:22:7:135:1',
  });
  assert.equal(owner.records.length, 1, 'Context-dependent hook call lost its lexical owner');
  const root = await session.run(`MATCH (fn:Fn {stableId:$id})
    RETURN EXISTS { MATCH (fn)-[:HAS_PARAMETER]->() } AS parameter,
      EXISTS { MATCH (fn)-[:DECLARES_JSX]->() } AS jsx`, { id: 'components/BaseTextInput.tsx:22:7:135:1' });
  assert.equal(root.records[0]?.get('parameter'), true, 'Scoped root lost HAS_PARAMETER');
  assert.equal(root.records[0]?.get('jsx'), true, 'Scoped root lost DECLARES_JSX');
  console.log(JSON.stringify({ ok: true, checks: 5, fullCursorRouteVerified: false,
    props: props.records[0].toObject(), context: context.records[0].toObject() }, null, 2));
} finally {
  await session.close();
  await driver.close();
}
