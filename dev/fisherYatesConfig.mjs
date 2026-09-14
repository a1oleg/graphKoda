import fs from 'node:fs';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import ts from 'typescript';

const sourcePath = 'examples/fisher-yates/src/shuffle.ts';
const source = ts.createSourceFile(sourcePath,
  fs.readFileSync(new URL('../' + sourcePath, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const entry = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'shuffle');
if (!entry) throw new Error('Fisher-Yates entry function shuffle is missing');
const keyword = entry.getChildren(source).find(n => n.kind === ts.SyntaxKind.FunctionKeyword);
const start = source.getLineAndCharacterOfPosition(keyword.getStart(source));
const end = source.getLineAndCharacterOfPosition(entry.getEnd());
export const fisherYatesRoot = `${sourcePath}:${start.line + 1}:${start.character}:${end.line + 1}:${end.character}`;
export const fisherYatesScope = 'fisher-yates';
export function auraConnection() {
  const env = dotenv.parse(fs.readFileSync(new URL('../graph/.env', import.meta.url)));
  if (!env.AURA_NEO4J_URI || !env.AURA_NEO4J_PASSWORD) throw new Error('Configure AURA_NEO4J_* in graph/.env');
  const driver = neo4j.driver(env.AURA_NEO4J_URI, neo4j.auth.basic(env.AURA_NEO4J_USERNAME || 'neo4j', env.AURA_NEO4J_PASSWORD));
  const database = env.AURA_NEO4J_DATABASE || 'neo4j';
  return { driver, database, session: driver.session({ database }) };
}
