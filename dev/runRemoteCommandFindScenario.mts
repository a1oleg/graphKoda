import process from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { instrumentNodePassSource } from './instrumentNodePassSource.mjs';

const FIND_STABLE_ID = 'screens/REPL.tsx:3416:57:3419:6';
const RELAY_URL = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';
const SESSION_ID = `remote-command-find-${Date.now()}`;
const ARTIFACT_PATH = path.resolve('graph/runtime/onSubmit-3416-find.analysis.json');

process.env.GRAPH_NODE_LOGGING = '1';
process.env.GRAPH_RUNTIME_SESSION_ID = SESSION_ID;
process.env.GRAPH_NODE_LOGGING_BATCH_MS = '0';

const manifest = JSON.parse(await readFile(
  path.resolve('graph/instrumentation/node-pass-targets.json'),
  'utf8',
));
const findTarget = manifest.targets.find((target: { stableId: string }) => (
  target.stableId === FIND_STABLE_ID
));
const targetAt = (stageName: string) => manifest.targets.find((target: { stageName?: string; startLine?: number }) => (
  target.startLine === 3418 && target.stageName === stageName
));
const nameTarget = manifest.targets.find((target: { stageName?: string; startLine?: number }) => (
  target.startLine === 3417 && target.stageName === 'command name'
));
const enabledTarget = targetAt('isCommandEnabled');
const directNameTarget = targetAt('name');
const aliasTarget = targetAt('aliases.includes');
const fallbackNameTarget = targetAt('getCommandName');
const localJsxTarget = manifest.targets.find((target: { stageName?: string; startLine?: number }) => (
  target.startLine === 3416 && target.stageName === 'type === local-jsx'
));
const requiredTargets = [
  findTarget,
  nameTarget,
  enabledTarget,
  directNameTarget,
  aliasTarget,
  fallbackNameTarget,
  localJsxTarget,
];
if (requiredTargets.some((target) => !target)) {
  throw new Error('Remote command find instrumentation targets are incomplete');
}

const replPath = path.resolve('screens/REPL.tsx');
const replSource = await readFile(replPath, 'utf8');
const instrumentedSource = await instrumentNodePassSource(replSource, replPath);
for (const target of requiredTargets) {
  if (!instrumentedSource.includes(target.stableId)) {
    throw new Error(`Babel output does not contain ${target.stableId}`);
  }
}

const {
  evaluateCollectionCall,
  evaluateNode,
  flushPendingNodePassEvents,
  installRuntimeNodePassReporter,
  wrapCollectionCallback,
} = await import('./runtimeNodePassReporter.mjs');

if (!installRuntimeNodePassReporter()) throw new Error('Runtime node-pass reporter was not installed');

const runtimeDataUrl = new URL('/runtime-data', RELAY_URL);
const clearResponse = await fetch(runtimeDataUrl, { method: 'DELETE' });
if (!clearResponse.ok) throw new Error(`Could not clear runtime events: HTTP ${clearResponse.status}`);

type Command = {
  name: string;
  aliases?: string[];
  enabled: boolean;
  canonicalName: string;
  type: 'local-jsx' | 'prompt';
};
const input = '/legacy-help';
const commands: Command[] = [
  { name: 'legacy-help', enabled: false, canonicalName: 'legacy-help', type: 'local-jsx' },
  { name: 'other', aliases: ['other-alias'], enabled: true, canonicalName: 'other', type: 'prompt' },
  { name: 'help-v2', aliases: ['help'], enabled: true, canonicalName: 'legacy-help', type: 'local-jsx' },
];
const isCommandEnabled = (command: Command) => command.enabled;
const getCommandName = (command: Command) => command.canonicalName;

const callback = wrapCollectionCallback(findTarget, (command: Command) => {
  const name = evaluateNode(
    nameTarget,
    () => input.trim().slice(1).split(/\s/)[0],
  );
  return evaluateNode(enabledTarget, () => isCommandEnabled(command)) && (
    evaluateNode(directNameTarget, () => command.name === name)
    || evaluateNode(aliasTarget, () => command.aliases?.includes(name) || false)
    || evaluateNode(fallbackNameTarget, () => getCommandName(command) === name)
  );
});
const result = evaluateCollectionCall(findTarget, () => commands.find(callback));
const isLocalJsx = evaluateNode(localJsxTarget, () => result?.type === 'local-jsx');
await flushPendingNodePassEvents();

const analysisUrl = new URL('/runtime-analysis', RELAY_URL);
analysisUrl.searchParams.set('stableId', FIND_STABLE_ID);
analysisUrl.searchParams.set('sessionId', SESSION_ID);
const analysisResponse = await fetch(analysisUrl);
if (!analysisResponse.ok) throw new Error(`Runtime analysis failed: HTTP ${analysisResponse.status}`);
const { analysis } = await analysisResponse.json();

if (
  result?.name !== 'help-v2'
  || isLocalJsx !== true
  || analysis.totalIterations !== 3
  || analysis.matchedIterations !== 1
  || analysis.rejectedIterations !== 2
  || analysis.segments.length !== 3
) {
  throw new Error(`Unexpected remote command find statistics: ${JSON.stringify({ result, analysis })}`);
}

const artifact = {
  input,
  sessionId: SESSION_ID,
  stableId: FIND_STABLE_ID,
  result: result.name,
  isLocalJsx,
  analysis,
};
await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  babelTargets: requiredTargets.length,
  sessionId: SESSION_ID,
  iterations: analysis.totalIterations,
  matched: analysis.matchedIterations,
  rejected: analysis.rejectedIterations,
  result: result.name,
  isLocalJsx,
  segments: analysis.segments.map((segment: { label: string; count: number }) => ({
    label: segment.label,
    count: segment.count,
  })),
  artifactPath: ARTIFACT_PATH,
}, null, 2));
