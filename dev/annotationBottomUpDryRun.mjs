import fs from 'node:fs';
import path from 'node:path';
import neo4j from 'neo4j-driver';
import dotenv from 'dotenv';
import paths from './projectPaths.cjs';
import { resolveAnnotationSubjects, getAnnotationProfile, loadCompositionContextDependenciesMany } from '../graph/packages/orchestrator/src/orchestrator/annotationProfiles.js';

const args = process.argv.slice(2);
const roots = args.flatMap((arg, i) => arg === '--root' ? [args[i + 1]] : []);
if (!roots.length && !args.includes('--all-functions')) throw new Error('Specify --root stableId or --all-functions');
const outputIndex = args.indexOf('--output');
const output = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : path.join(paths.dataRoot, 'checks/annotation-bottom-up.json'));
dotenv.config({ path: path.join(paths.toolRoot, 'graph/.env'), quiet: true });
const uri = process.env.NEO4J_URI;
if (!/^\w+:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(uri || '')) throw new Error('Local Neo4j required');
const driver = neo4j.driver(uri, neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD), { maxTransactionRetryTime: 0 });
const session = driver.session({ database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', defaultAccessMode: neo4j.session.READ });
const read = { run: (query, parameters) => session.executeRead(tx => tx.run(query, parameters), { timeout: 30000 }) };
const tasks = new Map(), aliases = new Map(), hints = new Map(), requested = new Set();
let complete = false, error;
try {
  if (args.includes('--all-functions')) {
    const result = await read.run('MATCH (n:Fn) RETURN n.stableId AS id');
    roots.push(...result.records.map(r => r.get('id')).filter(Boolean));
  }
  const queue = [...new Set(roots)];
  for (let cursor = 0; cursor < queue.length;) {
    const end = Math.min(cursor + 32, queue.length);
    const batch = [...new Set(queue.slice(cursor, end))].filter(id => !requested.has(id));
    cursor = end;
    if (!batch.length) continue;
    batch.forEach(id => requested.add(id));
    const subjects = await resolveAnnotationSubjects(read, batch, hints);
    for (const id of batch) {
      const subject = subjects.get(id);
      if (!subject) { tasks.set(id, { id, blocked: 'missing-subject', dependencies: [] }); continue; }
      aliases.set(id, subject.stableId);
      if (tasks.has(subject.stableId)) continue;
      const profile = getAnnotationProfile(subject.annotationKind);
      const task = { id: subject.stableId, kind: subject.annotationKind, profileId: profile?.id, dependencies: [], boundaries: [] };
      tasks.set(task.id, task);
      if (!profile) { task.blocked = 'missing-profile'; continue; }
      task.blocked = 'dependencies-not-loaded';
      console.error(JSON.stringify({ phase: 'load', id: task.id, profile: profile.id }));
      const map = profile.dependenciesMany
        ? await profile.dependenciesMany(read, [task.id], {})
        : new Map([[task.id, await profile.dependencies(read, task.id, {})]]);
      const composition = profile.compositionContext ? await loadCompositionContextDependenciesMany(read, [task.id]) : new Map();
      const deps = [...(map.get(task.id) || []), ...(composition.get(task.id) || [])];
      for (const dep of deps) {
        if (!dep.stableId || dep.stableId === task.id) continue; // Same as the production resolver.
        if (!dep.recurse) { task.boundaries.push({ id: dep.stableId, role: dep.role }); continue; }
        if (!task.dependencies.includes(dep.stableId)) task.dependencies.push(dep.stableId);
        if (dep.annotationKind) hints.set(dep.stableId, dep.annotationKind);
        if (!requested.has(dep.stableId)) queue.push(dep.stableId);
      }
      delete task.blocked;
    }
    console.error(JSON.stringify({ phase: 'dependencies', requested: requested.size, tasks: tasks.size, queued: queue.length - cursor }));
  }
  complete = true;
} catch (failure) {
  error = failure.stack || String(failure);
  process.exitCode = 1;
} finally {
  await session.close();
  await driver.close();
}

const reverse = new Map(), remaining = new Map(), levels = new Map();
for (const task of tasks.values()) {
  task.dependencies = [...new Set(task.dependencies.map(id => aliases.get(id) || id))];
  remaining.set(task.id, task.dependencies.length);
  for (const dependency of task.dependencies) {
    if (!reverse.has(dependency)) reverse.set(dependency, []);
    reverse.get(dependency).push(task.id);
  }
}
let wave = [...tasks.values()].filter(t => !t.blocked && !t.dependencies.length).map(t => t.id);
const waves = [];
while (wave.length) {
  waves.push(wave);
  const next = [];
  for (const id of wave) {
    levels.set(id, waves.length - 1);
    for (const parent of reverse.get(id) || []) {
      remaining.set(parent, remaining.get(parent) - 1);
      if (!remaining.get(parent) && !tasks.get(parent)?.blocked) next.push(parent);
    }
  }
  wave = next;
}
const blocked = [...tasks.values()].filter(t => !levels.has(t.id)).map(t => ({
  ...t, reason: t.blocked || 'cycle-or-unresolved-dependency',
  waitingFor: t.dependencies.filter(id => !levels.has(id)),
}));
const report = {
  mode: 'profile-dependency-readiness-only', complete, error,
  ignoresExistingAnnotations: true, generatesAnnotations: false, persistsAnnotations: false,
  semanticCoverageCertified: false,
  roots: roots.map(id => ({ requestedId: id, id: aliases.get(id) || id, level: levels.get(aliases.get(id) || id) ?? null })),
  summary: { tasks: tasks.size, simulatedReady: levels.size, blocked: blocked.length, waves: waves.length },
  waves, blocked, tasks: [...tasks.values()],
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, complete, ...report.summary, roots: report.roots, error }));
