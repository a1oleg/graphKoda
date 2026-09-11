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
export function contextModel(nodes, edges) {
  const ids = new Set(nodes.map(n => n.stableId));
  if (!ids.has(helpersRoot) || ids.size !== nodes.length) throw new Error('Invalid context nodes');
  for (const e of edges) if (!ids.has(e.from) || !ids.has(e.to)) throw new Error('Missing context endpoint');
  return { root: helpersRoot, title: 'helpers.clearBuffer',
    task: 'Зачем после отправки очищается буфер редактирования?',
    completion: 'Контекст clearBuffer собран',
    assumptions: 'Обычная отправка из PromptInput. Выбрана ветка clearBuffer. Маршрут загружен из Aura; тексты аннотаций подготовлены по коду.',
    nodes: nodes.map(n => ({ id: n.stableId, stableId: n.stableId,
      title: n.contextTitle, file: n.repoRelativePath, line: Number(n.startLine),
      deps: edges.filter(e => e.from === n.stableId).map(e => e.to),
      relations: Object.fromEntries(edges.filter(e => e.from === n.stableId).map(e => [e.to, e.type])),
      syntax: { description: n.contextKind, parts: [[n.contextTitle, 'value']] },
      need: n.contextQuestion, result: n.contextAnnotation,
    })) };
}
export async function loadHelpersContext() {
  const { driver, session } = auraConnection();
  try {
    return await session.executeRead(async tx => {
      const r = await tx.run(`MATCH (a)-[r]->(b) WHERE r.contextScope=$scope
        RETURN properties(a) AS a, properties(b) AS b, type(r) AS type ORDER BY r.contextOrder`, { scope: helpersScope });
      const nodes = new Map(); const edges = [];
      for (const row of r.records) {
        const a = row.get('a'), b = row.get('b');
        nodes.set(a.stableId, a); nodes.set(b.stableId, b);
        edges.push({ from: a.stableId, to: b.stableId, type: row.get('type') });
      }
      if (nodes.size !== 4 || edges.length !== 3) throw new Error('Incomplete helpers context in Aura');
      return contextModel([...nodes.values()], edges);
    });
  } finally { await session.close(); await driver.close(); }
}
