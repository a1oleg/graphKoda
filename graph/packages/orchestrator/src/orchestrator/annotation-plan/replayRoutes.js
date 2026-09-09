import {scenario} from './replayModel.js';
import {speculationScenario} from './speculationReplay.js';

export const replayRoutes = [
  {stableId: 'screens/REPL.tsx:3142:82:3146:3', model: speculationScenario},
  {stableId: 'screens/REPL.tsx:3142:38:3142:51', model: scenario},
];

export function resolveReplayRoute(stableId) {
  return replayRoutes.find(route => route.stableId === stableId);
}

export function replayLaunch(stableId, baseUrl) {
  if (typeof stableId !== 'string' || !stableId.trim()) {
    return {status: 400, body: {ok: false, error: 'stableId is required'}};
  }
  const route = resolveReplayRoute(stableId.trim());
  if (!route) return {status: 404, body: {ok: false, error: 'No authored annotation route for this stableId'}};
  const url = new URL('/annotation-plan/assets/replay.html', baseUrl);
  url.searchParams.set('stableId', route.stableId);
  return {status: 200, body: {
    ok: true, stableId: route.stableId, title: route.model.nodes.find(node => node.id === route.model.root).title,
    mode: 'authored', url: url.href,
  }};
}
