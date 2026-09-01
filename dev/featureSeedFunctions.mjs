import { buildStableIdLocation } from '../graph/stableIdModel.js';

const workspaceRoot = process.cwd();

const FEATURE_PATH_SNIPPETS = [
  '/src/components/calls/phone/PhoneCall.tsx',
  '/src/components/calls/group/GroupCall.tsx',
  '/src/global/actions/api/calls.async.ts',
  '/src/lib/secret-sauce/secretsauce.ts',
  '/src/lib/secret-sauce/p2p.ts',
  '/src/lib/secret-sauce/index.ts',
  '/src/api/gramjs/methods/calls.ts',
  '/src/api/gramjs/apiBuilders/calls.ts',
  '/src/api/types/calls.ts',
];

const SEED_RULES = [
  {
    pathSnippet: '/src/global/actions/api/calls.async.ts',
    exactNames: ['toggleGroupCallPresentation'],
  },
  {
    pathSnippet: '/src/lib/secret-sauce/secretsauce.ts',
    exactNames: ['getUserStream', 'toggleStream', 'startSharingScreen', 'leavePresentation', 'initializeConnection'],
  },
  {
    pathSnippet: '/src/lib/secret-sauce/p2p.ts',
    exactNames: ['getUserStream', 'toggleStreamP2p'],
  },
  {
    pathSnippet: '/src/components/calls/group/GroupCall.tsx',
    nameIncludes: ['presentation', 'screen'],
  },
  {
    pathSnippet: '/src/components/calls/phone/PhoneCall.tsx',
    nameIncludes: ['presentation', 'screen'],
  },
];

function normalizeFnRecord(record) {
  const location = buildStableIdLocation(record, { workspaceRoot });
  return {
    stableId: record.stableId,
    name: record.name || '<anonymous>',
    location,
  };
}

function matchesSeedRule(fnRecord) {
  return SEED_RULES.some((rule) => {
    if (!fnRecord.location.absolutePath.includes(rule.pathSnippet.replace(/\\/g, '/'))) {
      return false;
    }

    if (rule.exactNames?.includes(fnRecord.name)) {
      return true;
    }

    const lowerName = fnRecord.name.toLowerCase();
    return Boolean(rule.nameIncludes?.some((token) => lowerName.includes(token)));
  });
}

async function runRead(session, query, params = {}) {
  const result = await session.run(query, params);
  return result.records.map((record) => Object.fromEntries(record.keys.map((key) => [key, record.get(key)])));
}

async function findScreenshareSeedFunctions(session) {
  const candidates = await runRead(
    session,
    `
      MATCH (fn:Fn)
      WHERE any(pathSnippet IN $pathSnippets WHERE fn.stableId CONTAINS pathSnippet)
      RETURN DISTINCT fn.stableId AS stableId, fn.name AS name
      ORDER BY stableId
    `,
    { pathSnippets: FEATURE_PATH_SNIPPETS },
  );

  return candidates
    .map((record) => normalizeFnRecord(record))
    .filter((record) => matchesSeedRule(record));
}

async function findHeadFunctionByStableId(session, stableId) {
  const rows = await runRead(
    session,
    `
      MATCH (fn:Fn {stableId: $stableId})
      RETURN fn.stableId AS stableId, fn.name AS name
      LIMIT 1
    `,
    { stableId },
  );

  if (!rows.length) {
    throw new Error(`Head function was not found in Neo4j: ${stableId}`);
  }

  return normalizeFnRecord(rows[0]);
}

async function findHeadFunctionByName(session, name, pathSnippet) {
  const rows = await runRead(
    session,
    `
      MATCH (fn:Fn)
      WHERE fn.name = $name
        AND ($pathSnippet IS NULL OR fn.stableId CONTAINS $pathSnippet)
      RETURN fn.stableId AS stableId, fn.name AS name
      ORDER BY stableId
      LIMIT 12
    `,
    { name, pathSnippet: pathSnippet || null },
  );

  if (!rows.length) {
    throw new Error(`Head function was not found in Neo4j by name: ${name}`);
  }
  if (rows.length > 1) {
    const variants = rows.map((row) => row.stableId).join('\n');
    throw new Error(`Head function name is ambiguous: ${name}\nUse --head-path-snippet or --head-fn-stable-id.\nMatches:\n${variants}`);
  }

  return normalizeFnRecord(rows[0]);
}

export async function resolveSeedFunctions(session, args) {
  if (args.mode === 'screenshare') {
    return findScreenshareSeedFunctions(session);
  }

  if (args.headFnStableId) {
    return [await findHeadFunctionByStableId(session, args.headFnStableId)];
  }

  return [await findHeadFunctionByName(session, args.headFnName, args.headPathSnippet)];
}
