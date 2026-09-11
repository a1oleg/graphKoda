import fs from 'node:fs';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';

export const helpersRoot = 'screens/REPL.tsx:3142:53:3142:80';
export const helpersScope = 'helpers-clearBuffer';
export function auraConnection() {
  const env = dotenv.parse(fs.readFileSync(new URL('../../../../.env', import.meta.url)));
  const uri = env.AURA_NEO4J_URI;
  if (!uri || !env.AURA_NEO4J_PASSWORD) throw new Error('Aura connection is not configured');
  const driver = neo4j.driver(uri, neo4j.auth.basic(env.AURA_NEO4J_USERNAME, env.AURA_NEO4J_PASSWORD));
  return { driver, session: driver.session({ database: env.AURA_NEO4J_DATABASE || 'neo4j' }) };
}
export function contextModel(nodes, edges, options = {}) {
  const root = options.root || helpersRoot;
  const ids = new Set(nodes.map(n => n.stableId));
  if (!ids.has(root) || ids.size !== nodes.length) throw new Error('Invalid context nodes');
  for (const e of edges) if (!ids.has(e.from) || !ids.has(e.to)) throw new Error('Missing context endpoint');
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Context cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of edges.filter(e => e.from === id)) visit(edge.to);
    visiting.delete(id); visited.add(id);
  }
  visit(root);
  if (visited.size !== ids.size) throw new Error('Disconnected context nodes');
  return { root, title: options.title || 'helpers.clearBuffer',
    task: options.task || 'Зачем после отправки очищается буфер редактирования?',
    completion: options.completion || 'Контекст clearBuffer собран',
    assumptions: options.assumptions || 'Обычная отправка из PromptInput. Выбрана ветка clearBuffer. Маршрут загружен из Aura; тексты аннотаций подготовлены по коду.',
    nodes: nodes.map(n => ({ id: n.stableId, stableId: n.stableId,
      title: n.contextTitle, file: n.repoRelativePath, line: Number(n.startLine),
      system: n.contextSystemBoundary === true,
      deps: edges.filter(e => e.from === n.stableId).map(e => e.to),
      relations: Object.fromEntries(edges.filter(e => e.from === n.stableId).map(e => [e.to, e.type])),
      syntax: { description: [n.contextKind, n.contextInlineSystem].filter(Boolean).join(' · '), parts: [[n.contextTitle, n.contextSystemBoundary ? 'type' : 'value']] },
      need: n.contextQuestion, result: n.contextAnnotation,
    })) };
}
export async function loadHelpersContext() {
  return loadAuraContext(helpersScope);
}
export async function loadAuraContext(scope, options = {}) {
  const { driver, session } = auraConnection();
  try {
    return await session.executeRead(async tx => {
      const r = await tx.run(`MATCH (a)-[r]->(b) WHERE r.contextScope=$scope
        RETURN properties(a) AS a, properties(b) AS b, type(r) AS type ORDER BY r.contextOrder`, { scope });
      const nodes = new Map(); const edges = [];
      for (const row of r.records) {
        const a = row.get('a'), b = row.get('b');
        nodes.set(a.stableId, a); nodes.set(b.stableId, b);
        edges.push({ from: a.stableId, to: b.stableId, type: row.get('type') });
      }
      if (!nodes.size || !edges.length) throw new Error(`Missing ${scope} context in Aura`);
      return contextModel([...nodes.values()], edges, options);
    });
  } finally { await session.close(); await driver.close(); }
}
