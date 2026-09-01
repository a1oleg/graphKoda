import fs from 'node:fs';
import path from 'node:path';

const PREFERRED_ROOT_OWNER_NAMES = ['Main', 'App'];

const MAIN_LAYOUT_SHELL_SLOT_COUNT = 4;
const COLLAPSIBLE_WRAPPER_OWNER_NAMES = new Set(['Transition', 'ShowTransition']);
const MAX_COLLAPSE_DEPTH = 8;
const REPO_ROOT = process.cwd();

function normalizeNeo4jValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeNeo4jValue);
  }

  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function') {
      return value.toNumber();
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeNeo4jValue(nestedValue)]),
    );
  }

  return value;
}

function normalizeRecord(record) {
  return Object.fromEntries(
    Object.entries(record.toObject()).map(([key, value]) => [key, normalizeNeo4jValue(value)]),
  );
}

async function runRead(driver, database, query, params = {}) {
  const session = driver.session({ database });

  try {
    const result = await session.run(query, params);
    return result.records.map(normalizeRecord);
  } finally {
    await session.close();
  }
}

function buildNodeId(kind, value) {
  return `${kind}:${value}`;
}

function buildEffectiveChildrenQuery() {
  return `
    MATCH (parent:ViewSurface {key: $surfaceKey})-[rel:EXPLORER_CONTAINS_VIEW_SURFACE]->(child:ViewSurface)
    RETURN
      child.key AS key,
      child.owner_name AS ownerName,
      child.owner_kind AS ownerKind,
      child.surface_kind AS surfaceKind,
      child.owner_repo_relative_path AS ownerRepoRelativePath,
      rel.via AS via,
      parent.key AS parentKey,
      rel.jsx_min_line AS jsxMinLine,
      rel.jsx_min_column AS jsxMinColumn,
      rel.max_depth AS maxDepth,
      rel.sample_tag_paths AS sampleTagPaths,
      rel.sample_element_names AS sampleElementNames,
      rel.sample_target_names AS sampleTargetNames,
      [] AS localDomainActionFamilyKeys,
      [] AS localDomainActionFamilyDetails,
      [] AS domainActionFamilyKeys,
      [] AS domainActionFamilyDetails,
      [] AS objectDomainDetails,
      [] AS localObjectDomainDetails
    ORDER BY coalesce(rel.jsx_min_line, 999999), coalesce(rel.jsx_min_column, 999999), ownerName, key
  `;
}

async function loadEffectiveChildrenRows(driver, database, surfaceKey) {
  return runRead(driver, database, buildEffectiveChildrenQuery(), { surfaceKey });
}

function normalizeFamilyDetails(entries) {
  const byFamilyKey = new Map();

  for (const entry of entries || []) {
    const familyKey = entry?.familyKey;
    if (!familyKey || familyKey === 'global') {
      continue;
    }

    if (!byFamilyKey.has(familyKey)) {
      byFamilyKey.set(familyKey, {
        familyKey,
        domainLabels: new Set(),
        evidenceKinds: new Set(),
        functionNames: new Set(),
        exposureSurfaceKeys: new Set(),
        sourceFamilyKeys: new Set(),
        objectDetails: [],
      });
    }

    const aggregate = byFamilyKey.get(familyKey);
    const objectDetails = Array.isArray(entry.objectDetails) ? entry.objectDetails : [];
    (entry.domainLabels || []).filter(Boolean).forEach((value) => aggregate.domainLabels.add(value));
    (entry.evidenceKinds || []).filter(Boolean).forEach((value) => aggregate.evidenceKinds.add(value));
    (entry.functionNames || []).filter(Boolean).forEach((value) => aggregate.functionNames.add(value));
    (entry.exposureSurfaceKeys || (entry.surfaceKey ? [entry.surfaceKey] : []))
      .filter(Boolean)
      .forEach((value) => aggregate.exposureSurfaceKeys.add(value));
    (entry.sourceFamilyKeys || []).filter(Boolean).forEach((value) => aggregate.sourceFamilyKeys.add(value));
    objectDetails.filter(Boolean).forEach((value) => aggregate.objectDetails.push(value));
  }

  return [...byFamilyKey.values()]
    .map((entry) => ({
      familyKey: entry.familyKey,
      domainLabels: [...entry.domainLabels].sort(),
      evidenceKinds: [...entry.evidenceKinds].sort(),
      functionNames: [...entry.functionNames].sort(),
      exposureSurfaceKeys: [...entry.exposureSurfaceKeys].sort(),
      sourceFamilyKeys: [...entry.sourceFamilyKeys].sort(),
      objectDetails: entry.objectDetails,
    }))
    .sort((left, right) => left.familyKey.localeCompare(right.familyKey));
}

function toSurfaceNode(row) {
  const localFamilyKeys = (row.localDomainActionFamilyKeys || []).filter((key) => key && key !== 'global').sort();
  const familyKeys = (row.domainActionFamilyKeys || []).filter((key) => key && key !== 'global').sort();
  const localFamilyDetails = normalizeFamilyDetails(row.localDomainActionFamilyDetails);
  const familyDetails = normalizeFamilyDetails(row.domainActionFamilyDetails);
  const localObjectDetails = normalizeObjectDomainDetails(row.localObjectDomainDetails?.length ? row.localObjectDomainDetails : localFamilyDetails);
  const objectDetails = normalizeObjectDomainDetails(row.objectDomainDetails?.length ? row.objectDomainDetails : familyDetails);

  return {
    id: buildNodeId('surface', row.key),
    key: row.key,
    parentKey: row.parentKey,
    ownerName: row.ownerName,
    ownerKind: row.ownerKind,
    surfaceKind: row.surfaceKind,
    ownerRepoRelativePath: row.ownerRepoRelativePath,
    via: row.via,
    localDomainActionFamilyKeys: localFamilyKeys,
    domainActionFamilyKeys: familyKeys,
    localDomainActionFamilyDetails: localFamilyDetails,
    domainActionFamilyDetails: familyDetails,
    localObjectDomainKeys: localObjectDetails.map((detail) => detail.objectKey),
    objectDomainKeys: objectDetails.map((detail) => detail.objectKey),
    localObjectDomainDetails: localObjectDetails,
    objectDomainDetails: objectDetails,
    jsxMinLine: row.jsxMinLine,
    jsxMinColumn: row.jsxMinColumn,
    maxDepth: row.maxDepth,
    sampleTagPaths: row.sampleTagPaths || [],
    sampleElementNames: row.sampleElementNames || [],
    sampleTargetNames: row.sampleTargetNames || [],
    layout: row.layout,
    hasChildren: true,
  };
}

function toAffordanceNode(row) {
  const familyDetails = normalizeFamilyDetails([
    ...(row.domainActionFamilyDetails || []),
  ]);
  const objectDetails = normalizeObjectDomainDetails(row.objectDomainDetails?.length ? row.objectDomainDetails : familyDetails);
  const handlers = (row.eventHandlerNames || []).filter(Boolean);
  const target = row.targetName || handlers[0];
  const childKind = row.childKind || 'affordance';
  const labelParts = [
    row.elementName || 'UI affordance',
    target ? `-> ${target}` : undefined,
  ].filter(Boolean);

  return {
    id: buildNodeId(childKind, row.key),
    key: `${childKind}:${row.key}`,
    affordanceKey: childKind === 'affordance' ? row.key : undefined,
    intentEntryKey: childKind === 'intent' ? row.key : undefined,
    parentKey: row.parentKey,
    ownerName: labelParts.join(' '),
    ownerKind: 'ui-affordance',
    surfaceKind: row.elementKind || 'action-trigger',
    ownerRepoRelativePath: row.ownerRepoRelativePath,
    via: 'ui-affordance',
    localDomainActionFamilyKeys: familyDetails.map((detail) => detail.familyKey),
    domainActionFamilyKeys: familyDetails.map((detail) => detail.familyKey),
    localDomainActionFamilyDetails: familyDetails,
    domainActionFamilyDetails: familyDetails,
    localObjectDomainKeys: objectDetails.map((detail) => detail.objectKey),
    objectDomainKeys: objectDetails.map((detail) => detail.objectKey),
    localObjectDomainDetails: objectDetails,
    objectDomainDetails: objectDetails,
    jsxMinLine: row.line,
    jsxMinColumn: row.column,
    sampleTagPaths: [],
    sampleElementNames: [row.elementName].filter(Boolean),
    sampleTargetNames: [target].filter(Boolean),
    layout: {
      placement: childKind === 'intent' ? 'ui-action-entry' : 'ui-affordance',
      summary: [
        row.elementKind || 'action-trigger',
        handlers.length ? `handlers:${handlers.join(',')}` : undefined,
      ].filter(Boolean).join(' | '),
    },
    hasChildren: false,
  };
}

function mergeDomainActionFamilyKeys(nodes) {
  return unique(nodes.flatMap((node) => node.domainActionFamilyKeys || [])).sort();
}

function mergeDomainActionFamilyDetails(nodes) {
  return normalizeFamilyDetails(nodes.flatMap((node) => node.domainActionFamilyDetails || []));
}

function normalizeObjectDomainDetails(familyDetails) {
  const byObjectKey = new Map();

  for (const detail of familyDetails || []) {
    if (detail?.objectKey) {
      if (!byObjectKey.has(detail.objectKey)) {
        byObjectKey.set(detail.objectKey, {
          objectKey: detail.objectKey,
          familyKeys: new Set(),
          evidenceKinds: new Set(),
          functionNames: new Set(),
          exposureSurfaceKeys: new Set(),
        });
      }

      const aggregate = byObjectKey.get(detail.objectKey);
      (detail.familyKeys || []).filter(Boolean).forEach((value) => aggregate.familyKeys.add(value));
      (detail.evidenceKinds || []).filter(Boolean).forEach((value) => aggregate.evidenceKinds.add(value));
      (detail.functionNames || []).filter(Boolean).forEach((value) => aggregate.functionNames.add(value));
      (detail.exposureSurfaceKeys || []).filter(Boolean).forEach((value) => aggregate.exposureSurfaceKeys.add(value));
      continue;
    }

    const objectEntries = (detail.objectDetails || []).filter((entry) => entry?.domainLabel);
    if (objectEntries.length) {
      for (const objectEntry of objectEntries) {
        const domainLabel = objectEntry.domainLabel;
        if (!byObjectKey.has(domainLabel)) {
          byObjectKey.set(domainLabel, {
            objectKey: domainLabel,
            familyKeys: new Set(),
            evidenceKinds: new Set(),
            functionNames: new Set(),
            exposureSurfaceKeys: new Set(),
          });
        }

        const aggregate = byObjectKey.get(domainLabel);
        aggregate.familyKeys.add(detail.familyKey);
        (objectEntry.evidenceKinds || detail.evidenceKinds || []).filter(Boolean).forEach((value) => aggregate.evidenceKinds.add(value));
        (objectEntry.functionNames || []).filter(Boolean).forEach((value) => aggregate.functionNames.add(value));
        (objectEntry.exposureSurfaceKeys || detail.exposureSurfaceKeys || [])
          .filter(Boolean)
          .forEach((value) => aggregate.exposureSurfaceKeys.add(value));
      }
      continue;
    }

    for (const domainLabel of detail.domainLabels || []) {
      if (!domainLabel) {
        continue;
      }

      if (!byObjectKey.has(domainLabel)) {
        byObjectKey.set(domainLabel, {
          objectKey: domainLabel,
          familyKeys: new Set(),
          evidenceKinds: new Set(),
          functionNames: new Set(),
          exposureSurfaceKeys: new Set(),
        });
      }

      const aggregate = byObjectKey.get(domainLabel);
      aggregate.familyKeys.add(detail.familyKey);
      (detail.evidenceKinds || []).filter(Boolean).forEach((value) => aggregate.evidenceKinds.add(value));
      (detail.functionNames || []).filter(Boolean).forEach((value) => aggregate.functionNames.add(value));
      (detail.exposureSurfaceKeys || []).filter(Boolean).forEach((value) => aggregate.exposureSurfaceKeys.add(value));
    }
  }

  return [...byObjectKey.values()]
    .map((entry) => ({
      objectKey: entry.objectKey,
      familyKeys: [...entry.familyKeys].sort(),
      evidenceKinds: [...entry.evidenceKinds].sort(),
      functionNames: [...entry.functionNames].sort(),
      exposureSurfaceKeys: [...entry.exposureSurfaceKeys].sort(),
    }))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
}

function mergeObjectDomainDetails(nodes) {
  const byObjectKey = new Map();

  for (const detail of nodes.flatMap((node) => node.objectDomainDetails || [])) {
    if (!detail?.objectKey) {
      continue;
    }

    if (!byObjectKey.has(detail.objectKey)) {
      byObjectKey.set(detail.objectKey, {
        objectKey: detail.objectKey,
        familyKeys: new Set(),
        evidenceKinds: new Set(),
        functionNames: new Set(),
        exposureSurfaceKeys: new Set(),
      });
    }

    const aggregate = byObjectKey.get(detail.objectKey);
    (detail.familyKeys || []).filter(Boolean).forEach((value) => aggregate.familyKeys.add(value));
    (detail.evidenceKinds || []).filter(Boolean).forEach((value) => aggregate.evidenceKinds.add(value));
    (detail.functionNames || []).filter(Boolean).forEach((value) => aggregate.functionNames.add(value));
    (detail.exposureSurfaceKeys || []).filter(Boolean).forEach((value) => aggregate.exposureSurfaceKeys.add(value));
  }

  return [...byObjectKey.values()]
    .map((entry) => ({
      objectKey: entry.objectKey,
      familyKeys: [...entry.familyKeys].sort(),
      evidenceKinds: [...entry.evidenceKinds].sort(),
      functionNames: [...entry.functionNames].sort(),
      exposureSurfaceKeys: [...entry.exposureSurfaceKeys].sort(),
    }))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
}

function mergeObjectDomainKeys(nodes) {
  return unique(nodes.flatMap((node) => node.objectDomainKeys || [])).sort();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeRowsByKey(rows) {
  const seen = new Set();
  const deduped = [];

  for (const row of rows) {
    if (!row?.key || seen.has(row.key)) {
      continue;
    }

    seen.add(row.key);
    deduped.push(row);
  }

  return deduped;
}

function isCollapsibleSurfaceRow(row) {
  if (COLLAPSIBLE_WRAPPER_OWNER_NAMES.has(row.ownerName)) {
    return true;
  }

  return row.ownerKind === 'render-helper'
    && !(row.localDomainActionFamilyKeys || []).filter(Boolean).length;
}

function isPromotedRootChildRow(row, promotedRootKeys) {
  return row?.key && promotedRootKeys?.has(row.key);
}

function stripKnownSourceExtension(repoRelativePath) {
  return repoRelativePath.replace(/\.(?:tsx|ts|jsx|js)$/u, '');
}

function buildStyleCandidatePaths(row) {
  const repoRelativePath = String(row.ownerRepoRelativePath || '').replaceAll('\\', '/');
  if (!repoRelativePath) {
    return [];
  }

  const withoutExtension = stripKnownSourceExtension(repoRelativePath);
  const withoutAsync = withoutExtension.replace(/\.async$/u, '');
  const directory = path.posix.dirname(withoutExtension);
  const names = unique([
    path.posix.basename(withoutExtension),
    path.posix.basename(withoutAsync),
    ...(row.sampleElementNames || []),
    String(row.ownerName || '').replace(/Async$/u, ''),
  ]);
  const bases = unique([
    withoutExtension,
    withoutAsync,
    ...names.map((name) => path.posix.join(directory, name)),
  ]);

  return unique(bases.flatMap((base) => [`${base}.module.scss`, `${base}.scss`]))
    .map((candidate) => path.join(REPO_ROOT, candidate));
}

function readFirstExistingStyle(row) {
  for (const candidate of buildStyleCandidatePaths(row)) {
    if (fs.existsSync(candidate)) {
      return {
        repoRelativePath: path.relative(REPO_ROOT, candidate).replaceAll('\\', '/'),
        content: fs.readFileSync(candidate, 'utf8'),
      };
    }
  }

  return undefined;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractSelectorBlock(content, selector) {
  const match = new RegExp(`${escapeRegExp(selector)}\\s*\\{`, 'u').exec(content);
  if (!match) {
    return undefined;
  }

  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < content.length; index += 1) {
    if (content[index] === '{') {
      depth += 1;
    } else if (content[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(match.index, index + 1);
      }
    }
  }

  return undefined;
}

function extractRelevantStyleBlock(row, content) {
  const selectorNames = unique([
    ...(row.sampleElementNames || []),
    String(row.ownerName || '').replace(/Async$/u, ''),
  ]);
  const blocks = [
    extractSelectorBlock(content, '.root'),
    ...selectorNames.map((name) => extractSelectorBlock(content, `#${name}`)),
  ].filter(Boolean);

  if (blocks.length) {
    return blocks.join('\n');
  }

  return content;
}

function readLayoutEvidence(row) {
  const style = readFirstExistingStyle(row);
  if (!style) {
    return {
      placement: 'unclassified',
      summary: 'No adjacent SCSS layout evidence found.',
    };
  }

  const relevant = extractRelevantStyleBlock(row, style.content);
  const hasFixed = /\bposition\s*:\s*fixed\b/u.test(relevant);
  const hasAbsolute = /\bposition\s*:\s*absolute\b/u.test(relevant);
  const hasInsetZero = /\binset\s*:\s*0\b/u.test(relevant);
  const hasTopZero = /\btop\s*:\s*0\b/u.test(relevant);
  const hasRightZero = /\bright\s*:\s*0\b/u.test(relevant);
  const hasBottomZero = /\bbottom\s*:\s*0\b/u.test(relevant);
  const hasLeftZero = /\bleft\s*:\s*0\b/u.test(relevant);
  const hasBottom = /\bbottom\s*:/u.test(relevant);
  const hasModalLayout = /\.modal(?:-|_|\b)|\.modal-dialog\b|\.modal-content\b/u.test(relevant);
  const zIndex = /\bz-index\s*:\s*([^;]+);/u.exec(relevant)?.[1]?.trim();
  const position = /\bposition\s*:\s*([^;]+);/u.exec(relevant)?.[1]?.trim();
  const isFullScreen = hasInsetZero || (hasTopZero && hasRightZero && hasBottomZero && hasLeftZero);

  let placement = 'unclassified';
  if (hasFixed && /overlay-effects|confetti/u.test(zIndex || relevant)) {
    placement = 'fixed-effects';
  } else if (hasFixed && isFullScreen) {
    placement = 'fixed-top';
  } else if (hasModalLayout) {
    placement = 'modal';
  } else if (hasAbsolute && hasBottom) {
    placement = 'bottom-absolute';
  } else if (hasFixed) {
    placement = 'fixed';
  } else if (hasAbsolute) {
    placement = 'absolute';
  }

  const coordinates = [
    hasInsetZero ? 'inset:0' : undefined,
    hasTopZero ? 'top:0' : undefined,
    hasRightZero ? 'right:0' : undefined,
    hasBottomZero ? 'bottom:0' : undefined,
    hasLeftZero ? 'left:0' : undefined,
  ].filter(Boolean).join(', ');

  return {
    placement,
    position,
    zIndex,
    isFullScreen,
    styleRepoRelativePath: style.repoRelativePath,
    summary: [
      style.repoRelativePath,
      position ? `position:${position}` : undefined,
      zIndex ? `z:${zIndex}` : undefined,
      coordinates || undefined,
    ].filter(Boolean).join(' | '),
  };
}

function withLayoutEvidence(row) {
  return {
    ...row,
    layout: readLayoutEvidence(row),
  };
}

function groupByPlacement(rows) {
  const groups = {
    top: [],
    bottom: [],
    modal: [],
    effects: [],
    other: [],
  };

  for (const row of rows.map(withLayoutEvidence)) {
    if (row.layout.placement === 'fixed-top' || row.layout.placement === 'fixed') {
      groups.top.push(row);
    } else if (row.layout.placement === 'fixed-effects') {
      groups.effects.push(row);
    } else if (row.layout.placement === 'modal') {
      groups.modal.push(row);
    } else if (row.layout.placement === 'bottom-absolute' || row.layout.placement === 'absolute') {
      groups.bottom.push(row);
    } else {
      groups.other.push(row);
    }
  }

  return groups;
}

function buildContextualWrapperChildrenQuery() {
  return `
    MATCH (selected:ViewSurface {key: $surfaceKey})
    WHERE selected.owner_name IN ['Transition', 'ShowTransition']
    MATCH (parent:ViewSurface {key: $parentSurfaceKey})-[:NESTS_VIEW_SURFACE]->(child:ViewSurface)
    WHERE child.owner_kind = 'render-helper'
    RETURN
      child.key AS key,
      child.owner_name AS ownerName,
      child.owner_kind AS ownerKind,
      child.surface_kind AS surfaceKind,
      child.owner_repo_relative_path AS ownerRepoRelativePath,
      'contextual-nested-via-' + selected.owner_name AS via,
      parent.key AS parentKey,
      null AS jsxMinLine,
      null AS jsxMinColumn,
      null AS maxDepth,
      [] AS sampleTagPaths,
      [] AS sampleElementNames,
      [] AS sampleTargetNames,
      [] AS localDomainActionFamilyKeys,
      [] AS localDomainActionFamilyDetails,
      [] AS domainActionFamilyKeys,
      [] AS domainActionFamilyDetails,
      [] AS objectDomainDetails,
      [] AS localObjectDomainDetails
    ORDER BY ownerName, key
  `;
}

async function loadRawChildrenRows(driver, database, surfaceKey, parentSurfaceKey) {
  let rows = await loadEffectiveChildrenRows(driver, database, surfaceKey);
  if (!rows.length && parentSurfaceKey) {
    rows = await runRead(
      driver,
      database,
      buildContextualWrapperChildrenQuery(),
      { surfaceKey, parentSurfaceKey },
    );
  }

  return rows;
}

async function loadDisplayChildrenRows(driver, database, surfaceKey, parentSurfaceKey, {
  collapseStructural = true,
  depth = 0,
  promotedRootKeys = new Set(),
  visited = new Set(),
} = {}) {
  const rows = await loadRawChildrenRows(driver, database, surfaceKey, parentSurfaceKey);

  if (!collapseStructural || depth >= MAX_COLLAPSE_DEPTH) {
    return dedupeRowsByKey(rows);
  }

  const displayRows = [];

  for (const row of rows) {
    if (isPromotedRootChildRow(row, promotedRootKeys)) {
      continue;
    }

    if (!isCollapsibleSurfaceRow(row) || visited.has(row.key)) {
      displayRows.push(row);
      continue;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(row.key);
    const nestedRows = await loadDisplayChildrenRows(driver, database, row.key, row.parentKey || surfaceKey, {
      collapseStructural,
      depth: depth + 1,
      promotedRootKeys,
      visited: nextVisited,
    });

    if (nestedRows.length) {
      displayRows.push(...nestedRows);
    } else {
      displayRows.push(row);
    }
  }

  return dedupeRowsByKey(displayRows);
}

async function loadAffordanceChildRows(driver, database, surfaceKey) {
  return runRead(
    driver,
    database,
    `
      MATCH (surface:ViewSurface {key: $surfaceKey})
        -[:EXPOSES_UI_INTENT_ENTRY {source: 'uiIntentEntry'}]->
        (entry:UiIntentEntry {source: 'uiIntentEntry'})
      MATCH (sourceEntryPoint:UiActionEntrypoint {source: 'semantic/uiActionEntrypoint', action_name: entry.action_name})
        -[:RESOLVES_TO_ACTION_ENTRYPOINT {source: 'semantic/uiActionEntrypoint'}]->
        (targetEntryPoint:UiActionEntrypoint {source: 'semantic/uiActionEntrypoint'})
        -[:TARGETS_ACTION_ENTRYPOINT_FN {source: 'semantic/uiActionEntrypoint'}]->
        (targetFn:Fn)
      MATCH (objectFunction:UiObjectFunction:BusinessInstanceCreationFunction {source: 'semantic/uiObjectFunction', targetFnStableId: targetFn.stableId})
      WHERE entry.entry_kind = 'source-dispatch'
      WITH surface, entry,
           collect(DISTINCT {
             objectKey: objectFunction.domain_label,
             familyKeys: coalesce(objectFunction.family_keys, []),
             evidenceKinds: ['ui-object-function'],
             functionNames: [entry.action_name],
             exposureSurfaceKeys: [entry.key]
           }) AS objectDomainDetails
      WHERE size([detail IN objectDomainDetails WHERE detail.objectKey IS NOT NULL]) > 0
      WITH
        'intent' AS childKind,
        entry.key AS key,
        surface.key AS parentKey,
        surface.owner_repo_relative_path AS ownerRepoRelativePath,
        coalesce(entry.handler_name, entry.action_name, 'UI action') AS elementName,
        coalesce(entry.entry_kind, 'source-dispatch') AS elementKind,
        entry.action_name AS targetName,
        CASE WHEN entry.handler_name IS NULL THEN [] ELSE [entry.handler_name] END AS eventHandlerNames,
        entry.line AS line,
        entry.column AS column,
        [] AS domainActionFamilyDetails,
        objectDomainDetails
      WITH *
      ORDER BY coalesce(line, 999999), coalesce(column, 999999), elementName, key
      RETURN
        childKind,
        key,
        parentKey,
        ownerRepoRelativePath,
        elementName,
        elementKind,
        targetName,
        eventHandlerNames,
        line,
        column,
        domainActionFamilyDetails,
        objectDomainDetails
    `,
    { surfaceKey },
  );
}

async function loadPreferredRootSurfaces(driver, database) {
  const preferred = await runRead(
    driver,
    database,
    `
      MATCH (surface:ViewSurface)
      WHERE surface.owner_name IN $ownerNames
      RETURN
        surface.key AS key,
        surface.owner_name AS ownerName,
        surface.surface_kind AS surfaceKind,
        [] AS localDomainActionFamilyKeys,
        [] AS localDomainActionFamilyDetails,
        [] AS domainActionFamilyKeys,
        [] AS domainActionFamilyDetails,
        [] AS objectDomainDetails,
        [] AS localObjectDomainDetails
      ORDER BY CASE surface.owner_name
        WHEN 'Main' THEN 0
        WHEN 'App' THEN 1
        ELSE 2
      END, surface.key
    `,
    { ownerNames: PREFERRED_ROOT_OWNER_NAMES },
  );

  if (preferred.length) {
    return preferred;
  }

  return runRead(
    driver,
    database,
    `
      MATCH (surface:ViewSurface)
      WHERE NOT EXISTS {
        MATCH (:ViewSurface)-[:EXPLORER_CONTAINS_VIEW_SURFACE]->(surface)
      }
      RETURN
        surface.key AS key,
        surface.owner_name AS ownerName,
        surface.surface_kind AS surfaceKind,
        [] AS localDomainActionFamilyKeys,
        [] AS localDomainActionFamilyDetails,
        [] AS domainActionFamilyKeys,
        [] AS domainActionFamilyDetails,
        [] AS objectDomainDetails,
        [] AS localObjectDomainDetails
      ORDER BY ownerName, key
      LIMIT 25
    `,
  );
}
async function loadPreferredRootKeys(driver, database) {
  const rows = await runRead(
    driver,
    database,
    `
      MATCH (surface:ViewSurface)
      WHERE surface.owner_name IN $ownerNames
      RETURN surface.key AS key
    `,
    { ownerNames: PREFERRED_ROOT_OWNER_NAMES },
  );

  return rows.map((row) => row.key).filter(Boolean);
}

export async function loadUiExplorerRoots(driver, database) {
  const roots = await loadPreferredRootSurfaces(driver, database);

  return {
    roots: roots.map(toSurfaceNode),
  };
}

export async function loadUiExplorerTopBlocks(driver, database) {
  const rows = await runRead(
    driver,
    database,
    `
      MATCH (block:UiExplorerTopBlock {source: 'uiViewStructure'})-[rel:CONTAINS_TOP_BLOCK_SURFACE {source: 'uiViewStructure'}]->(surface:ViewSurface)
      RETURN
        block.key AS blockKey,
        block.title AS title,
        block.region AS region,
        block.description AS description,
        block.sort_order AS blockSortOrder,
        rel.role AS role,
        rel.sort_order AS surfaceSortOrder,
        surface.key AS key,
        surface.owner_name AS ownerName,
        surface.owner_kind AS ownerKind,
        surface.surface_kind AS surfaceKind,
        surface.owner_repo_relative_path AS ownerRepoRelativePath,
        rel.layout_placement AS layoutPlacement,
        rel.layout_summary AS layoutSummary,
        [] AS localDomainActionFamilyKeys,
        [] AS localDomainActionFamilyDetails,
        [] AS domainActionFamilyKeys,
        [] AS domainActionFamilyDetails,
        [] AS objectDomainDetails,
        [] AS localObjectDomainDetails
      ORDER BY block.sort_order, rel.sort_order, surface.owner_name
    `,
  );

  const blockByKey = new Map();
  for (const row of rows) {
    if (!blockByKey.has(row.blockKey)) {
      blockByKey.set(row.blockKey, {
        id: row.blockKey,
        title: row.title,
        region: row.region,
        description: row.description,
        sortOrder: row.blockSortOrder || 0,
        root: undefined,
        nodes: [],
      });
    }

    const block = blockByKey.get(row.blockKey);
    const surfaceNode = toSurfaceNode({
      ...row,
      layout: row.layoutPlacement || row.layoutSummary
        ? {
          placement: row.layoutPlacement || 'unclassified',
          summary: row.layoutSummary,
        }
        : undefined,
    });
    if (row.role === 'root') {
      block.root = surfaceNode;
    } else {
      block.nodes.push(surfaceNode);
    }
  }

  const rawBlocks = [...blockByKey.values()]
    .filter((block) => block.root || block.nodes.length)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));

  const blocks = rawBlocks.map((block) => ({
    ...block,
    sortOrder: undefined,
    domainActionFamilyKeys: [],
    domainActionFamilyDetails: [],
    objectDomainKeys: [],
    objectDomainDetails: [],
  }));

  return {
    blocks,
  };
}

export async function loadUiExplorerChildren(driver, database, surfaceKey, parentSurfaceKey) {
  const promotedRootKeys = new Set(
    (await loadPreferredRootKeys(driver, database))
      .filter((rootKey) => rootKey && rootKey !== surfaceKey),
  );
  const rows = await loadDisplayChildrenRows(driver, database, surfaceKey, parentSurfaceKey, { promotedRootKeys });
  const affordanceRows = await loadAffordanceChildRows(driver, database, surfaceKey);

  return {
    parentKey: surfaceKey,
    children: [
      ...rows.map(toSurfaceNode),
      ...affordanceRows.map(toAffordanceNode),
    ],
  };
}

export async function loadUiExplorerSurface(driver, database, surfaceKey) {
  const [surface] = await runRead(
    driver,
    database,
    `
      MATCH (surface:ViewSurface {key: $surfaceKey})
      OPTIONAL MATCH (surface)<-[:OWNS_VIEW_SURFACE]-(owner:Fn)
      RETURN
        surface.key AS key,
        surface.owner_name AS ownerName,
        surface.surface_kind AS surfaceKind,
        surface.ownerStableId AS ownerStableId,
        surface.source AS source,
        owner.stableId AS ownerFnStableId,
        owner.name AS ownerFnName,
        owner.repo_relative_path AS ownerFnRepoPath
      LIMIT 1
    `,
    { surfaceKey },
  );

  const affordances = await runRead(
    driver,
    database,
    `
      MATCH (surface:ViewSurface {key: $surfaceKey})-[:OWNS_UI_AFFORDANCE]->(affordance:UiAffordance)
      OPTIONAL MATCH (affordance)-[:TRIGGERS_STATIC_HANDLER]->(handler:Fn)
      OPTIONAL MATCH (affordance)-[:TARGETS_STATIC_FN]->(target:Fn)
      OPTIONAL MATCH (affordance)-[:MATCHES_VIEW_DESCENDANT]->(descendant:ViewInteractiveDescendant)
      OPTIONAL MATCH (descendant)-[:TARGETS_STATIC_FN]->(descendantTarget:Fn)
      OPTIONAL MATCH (affordance)-[:TRIGGERS_DOMAIN_ACTION]->(domainAction:UiDomainAction)
      OPTIONAL MATCH (affordance)-[:UI_EXPECTS_FEATURE {source: 'semantic/featureJoin'}]->(:FeatureJoinKey)<-[:BUSINESS_FULFILLS_FEATURE {source: 'semantic/featureJoin'}]-(objectFunction:UiObjectFunction)
      RETURN
        affordance.key AS key,
        affordance.element_name AS elementName,
        affordance.element_kind AS elementKind,
        affordance.primary_descendant_kind AS primaryDescendantKind,
        affordance.target_name AS targetName,
        affordance.event_handler_names AS eventHandlerNames,
        affordance.line AS line,
        affordance.column AS column,
        collect(DISTINCT handler { .stableId, .name }) AS handlers,
        collect(DISTINCT target { .stableId, .name }) AS targets,
        collect(DISTINCT descendant.target_name) AS matchedDescendantTargets,
        collect(DISTINCT descendantTarget { .stableId, .name }) AS matchedDescendantTargetFns,
        collect(DISTINCT domainAction {
          .key,
          .action_kind,
          .confidence,
          .family_key,
          .domain_keys,
          .domain_labels,
          .handler_name,
          .target_name,
          .targetFnStableId,
          .target_repo_relative_path,
          .hop_count
        }) AS domainActions,
        collect(DISTINCT objectFunction {
          .key,
          .name,
          .function_name,
          .object_type,
          .domain_key,
          .domain_label,
          .family_keys,
          .inferred_operation,
          .confidence,
          .target_name,
          .targetFnStableId,
          .target_repo_relative_path,
          .hop_count
        }) AS objectFunctions
      ORDER BY line, column, key
    `,
    { surfaceKey },
  );

  return {
    surface,
    affordances: affordances.map((affordance) => ({
      ...affordance,
      id: buildNodeId('affordance', affordance.key),
      handlers: (affordance.handlers || []).filter((item) => item?.stableId),
      targets: (affordance.targets || []).filter((item) => item?.stableId),
      matchedDescendantTargetFns: (affordance.matchedDescendantTargetFns || []).filter((item) => item?.stableId),
      matchedDescendantTargets: (affordance.matchedDescendantTargets || []).filter(Boolean),
      domainActions: (affordance.domainActions || []).filter((item) => item?.key),
      objectFunctions: (affordance.objectFunctions || []).filter((item) => item?.key),
    })),
  };
}

export async function loadUiExplorerAffordanceFlow(driver, database, affordanceKey) {
  const [affordance] = await runRead(
    driver,
    database,
    `
      MATCH (surface:ViewSurface)-[:OWNS_UI_AFFORDANCE]->(affordance:UiAffordance {key: $affordanceKey})
      OPTIONAL MATCH (affordance)-[:TRIGGERS_STATIC_HANDLER]->(handler:Fn)
      OPTIONAL MATCH (affordance)-[:TARGETS_STATIC_FN]->(target:Fn)
      OPTIONAL MATCH (affordance)-[:MATCHES_VIEW_DESCENDANT]->(descendant:ViewInteractiveDescendant)
      OPTIONAL MATCH (descendant)-[:TARGETS_STATIC_FN]->(descendantTarget:Fn)
      OPTIONAL MATCH (affordance)-[:TRIGGERS_DOMAIN_ACTION]->(domainAction:UiDomainAction)
      OPTIONAL MATCH (affordance)-[:UI_EXPECTS_FEATURE {source: 'semantic/featureJoin'}]->(:FeatureJoinKey)<-[:BUSINESS_FULFILLS_FEATURE {source: 'semantic/featureJoin'}]-(objectFunction:UiObjectFunction)
      RETURN
        surface.key AS surfaceKey,
        surface.owner_name AS surfaceName,
        affordance.key AS key,
        affordance.element_name AS elementName,
        affordance.target_name AS targetName,
        affordance.event_handler_names AS eventHandlerNames,
        collect(DISTINCT handler { .stableId, .name }) AS handlers,
        collect(DISTINCT target { .stableId, .name }) AS targets,
        collect(DISTINCT descendant { .key, .target_name, .primary_descendant_kind, .interaction_kinds }) AS descendants,
        collect(DISTINCT descendantTarget { .stableId, .name }) AS descendantTargets,
        collect(DISTINCT domainAction {
          .key,
          .action_kind,
          .confidence,
          .family_key,
          .domain_keys,
          .domain_labels,
          .handler_name,
          .target_name,
          .targetFnStableId,
          .target_repo_relative_path,
          .hop_count
        }) AS domainActions,
        collect(DISTINCT objectFunction {
          .key,
          .name,
          .function_name,
          .object_type,
          .domain_key,
          .domain_label,
          .family_keys,
          .inferred_operation,
          .confidence,
          .target_name,
          .targetFnStableId,
          .target_repo_relative_path,
          .hop_count
        }) AS objectFunctions
      LIMIT 1
    `,
    { affordanceKey },
  );

  if (!affordance) {
    return {
      affordance: undefined,
      nodes: [],
      edges: [],
    };
  }

  const fnStableIds = [
    ...(affordance.handlers || []).map((item) => item.stableId),
    ...(affordance.targets || []).map((item) => item.stableId),
    ...(affordance.descendantTargets || []).map((item) => item.stableId),
  ].filter(Boolean);

  const neighborRows = fnStableIds.length
    ? await runRead(
      driver,
      database,
      `
        MATCH (fn:Fn)
        WHERE fn.stableId IN $fnStableIds
        OPTIONAL MATCH (fn)-[rel:FUNCTION_RESOLVES_STATE_TARGET|USES_FAMILY|OWNS_VIEW_SURFACE|STATIC_CALLS|CALLS_FN|TARGETS_ACTION_FN]->(neighbor)
        RETURN
          fn.stableId AS fnStableId,
          fn.name AS fnName,
          type(rel) AS relType,
          labels(neighbor) AS neighborLabels,
          coalesce(neighbor.stableId, neighbor.key, neighbor.name, neighbor.objectKey) AS neighborId,
          coalesce(neighbor.name, neighbor.owner_name, neighbor.key, neighbor.objectKey, neighbor.resource_name) AS neighborName
        ORDER BY fnName, relType, neighborName
      `,
      { fnStableIds },
    )
    : [];

  const nodes = [];
  const edges = [];
  const seenNodes = new Set();

  const pushNode = (id, payload) => {
    if (seenNodes.has(id)) {
      return;
    }

    seenNodes.add(id);
    nodes.push({ id, ...payload });
  };

  const surfaceNodeId = buildNodeId('surface', affordance.surfaceKey);
  const affordanceNodeId = buildNodeId('affordance', affordance.key);

  pushNode(surfaceNodeId, {
    kind: 'surface',
    label: affordance.surfaceName,
    lane: 'surface',
  });
  pushNode(affordanceNodeId, {
    kind: 'affordance',
    label: affordance.targetName || affordance.elementName || 'Affordance',
    lane: 'affordance',
    eventHandlerNames: affordance.eventHandlerNames || [],
  });
  edges.push({ from: surfaceNodeId, to: affordanceNodeId, label: 'owns' });

  for (const handler of affordance.handlers || []) {
    const handlerNodeId = buildNodeId('fn', handler.stableId);
    pushNode(handlerNodeId, {
      kind: 'fn',
      label: handler.name || handler.stableId,
      lane: 'function',
      role: 'handler',
    });
    edges.push({ from: affordanceNodeId, to: handlerNodeId, label: 'triggers handler' });
  }

  for (const target of affordance.targets || []) {
    const targetNodeId = buildNodeId('fn', target.stableId);
    pushNode(targetNodeId, {
      kind: 'fn',
      label: target.name || target.stableId,
      lane: 'function',
      role: 'target',
    });
    edges.push({ from: affordanceNodeId, to: targetNodeId, label: 'targets fn' });
  }

  for (const descendant of affordance.descendants || []) {
    if (!descendant?.key) {
      continue;
    }

    const descendantNodeId = buildNodeId('descendant', descendant.key);
    pushNode(descendantNodeId, {
      kind: 'descendant',
      label: descendant.target_name || descendant.key,
      lane: 'affordance',
      role: descendant.primary_descendant_kind || 'interactive-descendant',
      interactionKinds: descendant.interaction_kinds || [],
    });
    edges.push({ from: affordanceNodeId, to: descendantNodeId, label: 'matches descendant' });
  }

  for (const descendantTarget of affordance.descendantTargets || []) {
    const descendantTargetNodeId = buildNodeId('fn', descendantTarget.stableId);
    pushNode(descendantTargetNodeId, {
      kind: 'fn',
      label: descendantTarget.name || descendantTarget.stableId,
      lane: 'function',
      role: 'descendant-target',
    });
    for (const descendant of affordance.descendants || []) {
      if (!descendant?.key) {
        continue;
      }
      const descendantNodeId = buildNodeId('descendant', descendant.key);
      edges.push({ from: descendantNodeId, to: descendantTargetNodeId, label: 'targets fn' });
    }
  }

  for (const domainAction of affordance.domainActions || []) {
    if (!domainAction?.key) {
      continue;
    }

    const actionNodeId = buildNodeId('domain-action', domainAction.key);
    pushNode(actionNodeId, {
      kind: 'domain-action',
      label: domainAction.action_kind || 'domain-action',
      lane: 'domain',
      role: domainAction.confidence || 'domain-evidence',
      familyKey: domainAction.family_key,
      domainKeys: domainAction.domain_keys || [],
      targetName: domainAction.target_name,
      targetRepoRelativePath: domainAction.target_repo_relative_path,
    });
    edges.push({ from: affordanceNodeId, to: actionNodeId, label: 'triggers domain action' });

    if (domainAction.family_key) {
      const familyNodeId = buildNodeId('family', domainAction.family_key);
      pushNode(familyNodeId, {
        kind: 'family',
        label: domainAction.family_key,
        lane: 'domain',
      });
      edges.push({ from: actionNodeId, to: familyNodeId, label: 'affects family' });
    }

    (domainAction.domain_keys || []).forEach((domainKey, index) => {
      const domainNodeId = buildNodeId('domain', domainKey);
      pushNode(domainNodeId, {
        kind: 'domain',
        label: domainAction.domain_labels?.[index] || domainKey,
        lane: 'domain',
      });
      edges.push({ from: actionNodeId, to: domainNodeId, label: 'affects domain' });
    });
  }

  for (const objectFunction of affordance.objectFunctions || []) {
    if (!objectFunction?.key) {
      continue;
    }

    const objectFunctionNodeId = buildNodeId('object-function', objectFunction.key);
    pushNode(objectFunctionNodeId, {
      kind: 'object-function',
      label: objectFunction.function_name || objectFunction.name || 'object-function',
      lane: 'domain',
      role: objectFunction.confidence || 'object-function',
      objectType: objectFunction.object_type,
      domainKey: objectFunction.domain_key,
      familyKeys: objectFunction.family_keys || [],
      inferredOperation: objectFunction.inferred_operation,
      targetRepoRelativePath: objectFunction.target_repo_relative_path,
    });
    edges.push({ from: affordanceNodeId, to: objectFunctionNodeId, label: 'triggers function' });

    if (objectFunction.domain_key) {
      const domainNodeId = buildNodeId('domain', objectFunction.domain_key);
      pushNode(domainNodeId, {
        kind: 'domain',
        label: objectFunction.domain_label || objectFunction.object_type || objectFunction.domain_key,
        lane: 'domain',
      });
      edges.push({ from: objectFunctionNodeId, to: domainNodeId, label: 'affects object' });
    }

    for (const familyKey of objectFunction.family_keys || []) {
      const familyNodeId = buildNodeId('family', familyKey);
      pushNode(familyNodeId, {
        kind: 'family',
        label: familyKey,
        lane: 'domain',
      });
      edges.push({ from: objectFunctionNodeId, to: familyNodeId, label: 'affects family' });
    }
  }

  for (const row of neighborRows) {
    if (!row.relType || !row.neighborId) {
      continue;
    }

    const fnNodeId = buildNodeId('fn', row.fnStableId);
    const lane = row.relType === 'OWNS_VIEW_SURFACE' ? 'result-surface' : 'data';
    const neighborNodeId = buildNodeId('neighbor', `${row.relType}:${row.neighborId}`);

    pushNode(fnNodeId, {
      kind: 'fn',
      label: row.fnName || row.fnStableId,
      lane: 'function',
    });
    pushNode(neighborNodeId, {
      kind: 'neighbor',
      label: row.neighborName || row.neighborId,
      lane,
      relType: row.relType,
      labels: row.neighborLabels || [],
    });
    edges.push({ from: fnNodeId, to: neighborNodeId, label: row.relType });
  }

  return {
    affordance,
    nodes,
    edges,
  };
}

export async function loadUiExplorerObjectFunctions(driver, database, { objectKey, familyKey } = {}) {
  const rows = await runRead(
    driver,
    database,
    `
      MATCH (objectFunction:UiObjectFunction:BusinessInstanceCreationFunction {source: 'semantic/uiObjectFunction'})
      WHERE ($objectKey IS NULL OR objectFunction.object_type = $objectKey OR objectFunction.domain_label = $objectKey)
        AND ($familyKey IS NULL OR $familyKey IN coalesce(objectFunction.family_keys, []))
      RETURN
        objectFunction.key AS key,
        objectFunction.function_name AS functionName,
        objectFunction.object_type AS objectType,
        objectFunction.domain_key AS domainKey,
        objectFunction.domain_label AS domainLabel,
        objectFunction.family_keys AS familyKeys,
        objectFunction.inferred_operation AS inferredOperation,
        objectFunction.confidence AS confidence,
        objectFunction.targetFnStableId AS targetFnStableId,
        objectFunction.target_repo_relative_path AS targetRepoRelativePath
      ORDER BY
        CASE objectFunction.confidence
          WHEN 'action-function-name' THEN 0
          WHEN 'api-method-name' THEN 1
          ELSE 2
        END,
        objectFunction.target_repo_relative_path,
        objectFunction.function_name
      LIMIT 300
    `,
    {
      objectKey: objectKey || null,
      familyKey: familyKey || null,
    },
  );

  return {
    objectKey: objectKey || null,
    familyKey: familyKey || null,
    functions: rows.map((row) => ({
      key: row.key,
      functionName: row.functionName,
      objectType: row.objectType,
      domainKey: row.domainKey,
      domainLabel: row.domainLabel,
      familyKeys: row.familyKeys || [],
      inferredOperation: row.inferredOperation,
      confidence: row.confidence,
      targetFnStableId: row.targetFnStableId,
      targetRepoRelativePath: row.targetRepoRelativePath,
    })),
  };
}

export async function loadUiExplorerObjectCatalog(driver, database) {
  const rows = await runRead(
    driver,
    database,
    `
      MATCH (surface:ViewSurface {source: 'uiViewStructure'})
        -[:OWNS_UI_AFFORDANCE]->
        (affordance:UiAffordance)
        -[:TRIGGERS_STATIC_HANDLER]->
        (handlerFn:Fn)
      MATCH (surface)
        -[:EXPOSES_UI_INTENT_ENTRY {source: 'uiIntentEntry'}]->
        (entry:UiIntentEntry {source: 'uiIntentEntry', handlerStableId: handlerFn.stableId})
      MATCH (sourceEntryPoint:UiActionEntrypoint {source: 'semantic/uiActionEntrypoint', action_name: entry.action_name})
        -[:RESOLVES_TO_ACTION_ENTRYPOINT {source: 'semantic/uiActionEntrypoint'}]->
        (targetEntryPoint:UiActionEntrypoint {source: 'semantic/uiActionEntrypoint'})
      MATCH (targetEntryPoint)-[:TARGETS_ACTION_ENTRYPOINT_FN {source: 'semantic/uiActionEntrypoint'}]->(targetFn:Fn)
      MATCH (objectFunction:UiObjectFunction:BusinessInstanceCreationFunction {source: 'semantic/uiObjectFunction', targetFnStableId: targetFn.stableId})
      WHERE coalesce(objectFunction.domain_label, '') <> ''
      WITH objectFunction.domain_label AS objectKey,
           collect(DISTINCT objectFunction.domain_key) AS domainKeys,
           coll.distinct(reduce(acc = [], keys IN collect(coalesce(objectFunction.family_keys, [])) | acc + keys)) AS familyKeys,
           collect(DISTINCT entry.action_name) AS functionNames
      RETURN
        objectKey,
        [key IN domainKeys WHERE key IS NOT NULL] AS domainKeys,
        [key IN familyKeys WHERE key IS NOT NULL] AS familyKeys,
        [name IN functionNames WHERE name IS NOT NULL] AS functionNames
      ORDER BY objectKey
    `,
  );

  return {
    objects: rows.map((row) => ({
      objectKey: row.objectKey,
      domainKeys: row.domainKeys || [],
      familyKeys: row.familyKeys || [],
      functionNames: row.functionNames || [],
    })),
  };
}

export async function loadUiExplorerObjectPaths(driver, database, { objectKey, familyKey } = {}) {
  if (!objectKey) {
    throw new Error('objectKey is required for /api/ui-explorer/object-paths.');
  }

  const rows = await runRead(
    driver,
    database,
    `
      CALL {
        MATCH (terminalSurface:ViewSurface {source: 'uiViewStructure'})
          -[:OWNS_UI_AFFORDANCE]->
          (affordance:UiAffordance)
          -[handlerRel:TRIGGERS_STATIC_HANDLER]->
          (handlerFn:Fn)
        MATCH (terminalSurface)
          -[:EXPOSES_UI_INTENT_ENTRY {source: 'uiIntentEntry'}]->
          (entry:UiIntentEntry {source: 'uiIntentEntry', handlerStableId: handlerFn.stableId})
        MATCH (sourceEntryPoint:UiActionEntrypoint {source: 'semantic/uiActionEntrypoint', action_name: entry.action_name})
          -[resolution:RESOLVES_TO_ACTION_ENTRYPOINT {source: 'semantic/uiActionEntrypoint'}]->
          (targetEntryPoint:UiActionEntrypoint {source: 'semantic/uiActionEntrypoint'})
        MATCH (targetEntryPoint)-[:TARGETS_ACTION_ENTRYPOINT_FN {source: 'semantic/uiActionEntrypoint'}]->(targetFn:Fn)
        MATCH (objectFunction:UiObjectFunction:BusinessInstanceCreationFunction {source: 'semantic/uiObjectFunction', targetFnStableId: targetFn.stableId})
        RETURN terminalSurface, affordance, handlerRel, handlerFn, objectFunction, resolution,
               affordance.key AS terminalKey,
               coalesce(affordance.primary_descendant_kind, affordance.element_kind, 'ui-affordance') AS terminalKind,
               coalesce(affordance.element_name, entry.action_name, objectFunction.function_name) AS terminalName,
               coalesce(entry.action_name, entry.target_name, objectFunction.function_name) AS uiActionName,
               coalesce(handlerFn.name, entry.handler_name) AS terminalHandlerName
      }
      WITH terminalSurface, affordance, handlerRel, objectFunction, resolution, terminalKey, terminalKind, terminalName, uiActionName, terminalHandlerName
      WHERE objectFunction.domain_label = $objectKey
        AND ($familyKey IS NULL OR $familyKey IN coalesce(objectFunction.family_keys, []))
      WITH
        terminalSurface,
        affordance,
        handlerRel,
        objectFunction,
        coalesce(terminalName, objectFunction.function_name) AS groupedTerminalName,
        coalesce(uiActionName, terminalName, objectFunction.function_name) AS groupedUiActionName,
        coalesce(terminalKind, 'object-function') AS groupedTerminalKind,
        terminalHandlerName,
        collect(DISTINCT terminalKey) AS terminalKeys,
        collect(DISTINCT CASE WHEN coalesce(resolution.hop_count, 0) = 0 THEN 'action-entrypoint-name' ELSE 'forwarded-action-entrypoint-name' END) AS resolutionKinds
      MATCH (block:UiExplorerTopBlock {source: 'uiViewStructure'})
      WITH DISTINCT block, terminalSurface, affordance, handlerRel, objectFunction, groupedTerminalName, groupedTerminalKind, terminalHandlerName, terminalKeys, resolutionKinds,
        groupedUiActionName,
        EXISTS {
          MATCH (block)-[:CONTAINS_TOP_BLOCK_SURFACE {source: 'uiViewStructure', role: 'node'}]->(:ViewSurface)
        } AS hasNodeStarts
      MATCH (block)-[topRel:CONTAINS_TOP_BLOCK_SURFACE {source: 'uiViewStructure'}]->(startSurface:ViewSurface {source: 'uiViewStructure'})
      WHERE (hasNodeStarts AND topRel.role = 'node') OR (NOT hasNodeStarts AND topRel.role = 'root')
      MATCH path=(startSurface)-[:EXPLORER_CONTAINS_VIEW_SURFACE*0..]->(terminalSurface)
      WITH DISTINCT
        block,
        topRel,
        [surfaceNode IN nodes(path) | {
          key: surfaceNode.key,
          ownerName: surfaceNode.owner_name,
          ownerKind: surfaceNode.owner_kind,
          surfaceKind: surfaceNode.surface_kind,
          ownerRepoRelativePath: surfaceNode.owner_repo_relative_path
        }] AS pathSurfaces,
        terminalSurface,
        affordance,
        handlerRel,
        objectFunction,
        groupedTerminalName,
        groupedUiActionName,
        groupedTerminalKind,
        terminalHandlerName,
        terminalKeys,
        resolutionKinds,
        length(path) AS blockDistance
      ORDER BY block.sort_order, coalesce(topRel.sort_order, 999999), blockDistance, terminalSurface.owner_name, affordance.line, affordance.column
      RETURN
        block.key AS blockKey,
        block.title AS blockTitle,
        block.region AS blockRegion,
        block.sort_order AS blockSortOrder,
        topRel.sort_order AS startSortOrder,
        objectFunction.domain_label AS objectKey,
        objectFunction.key AS objectFunctionKey,
        objectFunction.function_name AS functionName,
        head(terminalKeys) AS terminalKey,
        groupedTerminalKind AS terminalKind,
        groupedTerminalName AS terminalName,
        groupedUiActionName AS uiActionName,
        terminalHandlerName,
        head(terminalKeys) AS exposureKey,
        resolutionKinds AS resolutionKinds,
        affordance.element_name AS affordanceElementName,
        affordance.element_kind AS affordanceElementKind,
        affordance.primary_descendant_kind AS affordanceKind,
        affordance.line AS affordanceLine,
        affordance.column AS affordanceColumn,
        affordance.tag_path AS affordanceTagPath,
        handlerRel.event_handler_name AS affordanceEventName,
        false AS crossesModalInvocation,
        pathSurfaces AS surfaces
      ORDER BY
        blockSortOrder,
        coalesce(startSortOrder, 999999),
        affordanceLine,
        affordanceColumn,
        functionName,
        uiActionName,
        terminalName
    `,
    {
      objectKey,
      familyKey: familyKey || null,
    },
  );

  const pathKeys = new Set();
  const paths = [];
  for (const row of rows) {
    const surfaces = (row.surfaces || []).filter((surface) => surface?.key);
    const terminal = {
      key: row.terminalKey || `${row.objectFunctionKey}:${row.exposureKey || row.functionName}`,
      ownerName: row.terminalName || row.functionName || '(object function)',
      ownerKind: 'ui-affordance',
      surfaceKind: row.terminalKind || 'object-function',
      uiActionName: row.uiActionName || row.terminalName || row.functionName,
      functionName: row.functionName,
      handlerName: row.terminalHandlerName,
      exposureKey: row.exposureKey,
      elementName: row.affordanceElementName,
      elementKind: row.affordanceElementKind,
      affordanceKind: row.affordanceKind,
      line: row.affordanceLine,
      column: row.affordanceColumn,
      tagPath: row.affordanceTagPath,
      eventName: row.affordanceEventName,
      resolutionKind: (row.resolutionKinds || [])[0] || null,
      resolutionKinds: row.resolutionKinds || [],
    };
    const dedupeKey = [
      row.blockKey,
      row.objectFunctionKey,
      ...surfaces.map((surface) => surface.key),
      terminal.key,
      terminal.eventName,
      terminal.ownerName,
      terminal.surfaceKind,
    ].join('|');
    if (pathKeys.has(dedupeKey)) {
      continue;
    }
    pathKeys.add(dedupeKey);
    paths.push({
      blockKey: row.blockKey,
      blockTitle: row.blockTitle,
      blockRegion: row.blockRegion,
      objectKey: row.objectKey,
      objectFunctionKey: row.objectFunctionKey,
      functionName: row.functionName,
      uiActionName: row.uiActionName || row.functionName,
      crossesModalInvocation: Boolean(row.crossesModalInvocation),
      surfaces,
      terminal,
    });
  }

  return {
    objectKey,
    familyKey: familyKey || null,
    paths,
  };
}

export async function loadUiExplorerModalStrictDiagnostics(driver, database, { objectKey } = {}) {
  if (!objectKey) {
    throw new Error('objectKey is required for /api/ui-explorer/modal-strict-diagnostics.');
  }

  const rows = await runRead(
    driver,
    database,
    `
      MATCH (:UiExplorerTopBlock {source: 'uiViewStructure', title: 'Main Modal Layer'})
        -[topRel:CONTAINS_TOP_BLOCK_SURFACE {source: 'uiViewStructure'}]->
        (modalRoot:ViewSurface {source: 'uiViewStructure'})
      WHERE topRel.role = 'node'
      MATCH (modalRoot)
        -[:EXPLORER_CONTAINS_VIEW_SURFACE*0..10]->
        (tracedSurface:ViewSurface {source: 'uiViewStructure'})
      MATCH (tracedSurface)-[traceRel:EXPOSES_OBJECT_FUNCTION {source: 'semantic/uiObjectTrace'}]->
        (objectFunction:UiObjectFunction:BusinessInstanceCreationFunction {source: 'semantic/uiObjectFunction'})
      WHERE objectFunction.domain_label = $objectKey
      WITH
        modalRoot AS surface,
        modalRoot.key AS modalRootKey,
        collect(DISTINCT objectFunction.function_name) AS functionNames,
        collect(DISTINCT coalesce(traceRel.owner_surface_key, tracedSurface.key)) AS ownerSurfaceKeys,
        collect(DISTINCT {
          key: tracedSurface.key,
          ownerName: tracedSurface.owner_name,
          ownerKind: tracedSurface.owner_kind,
          surfaceKind: tracedSurface.surface_kind,
          ownerRepoRelativePath: tracedSurface.owner_repo_relative_path
        }) AS tracedSurfaces
      CALL (surface, modalRootKey) {
        OPTIONAL MATCH strictPath=(strictOwner:ViewSurface {source: 'uiViewStructure'})
          -[:EXPLORER_CONTAINS_VIEW_SURFACE*1..10]->
          (surface)
        WHERE strictOwner.owner_name <> 'Main'
          AND strictOwner.key <> modalRootKey
          AND none(node IN nodes(strictPath)[0..size(nodes(strictPath)) - 1] WHERE node.key = modalRootKey)
          AND none(node IN nodes(strictPath)[0..size(nodes(strictPath)) - 1] WHERE coalesce(node.owner_name, '') IN ['App', 'Main', 'MainAsync', 'renderContent'])
          AND NOT coalesce(strictOwner.surface_kind, '') CONTAINS 'modal'
          AND NOT coalesce(strictOwner.surface_kind, '') CONTAINS 'overlay'
          AND NOT coalesce(strictOwner.owner_kind, '') CONTAINS 'render-helper'
        WITH strictPath
        ORDER BY length(strictPath)
        LIMIT 10
        RETURN collect([
          node IN nodes(strictPath) |
          {
            key: node.key,
            ownerName: node.owner_name,
            ownerKind: node.owner_kind,
            surfaceKind: node.surface_kind,
            ownerRepoRelativePath: node.owner_repo_relative_path
          }
        ]) AS strictUiPaths
      }
      CALL (surface) {
        OPTIONAL MATCH (parentSurface:ViewSurface {source: 'uiViewStructure'})
          -[:EXPLORER_CONTAINS_VIEW_SURFACE]->
          (surface)
        RETURN collect(DISTINCT {
          key: parentSurface.key,
          ownerName: parentSurface.owner_name,
          ownerKind: parentSurface.owner_kind,
          surfaceKind: parentSurface.surface_kind,
          ownerRepoRelativePath: parentSurface.owner_repo_relative_path
        }) AS explorerParents
      }
      RETURN
        surface.key AS surfaceKey,
        surface.owner_name AS surfaceName,
        surface.owner_kind AS surfaceOwnerKind,
        surface.surface_kind AS surfaceKind,
        surface.owner_repo_relative_path AS surfaceRepoRelativePath,
        functionNames,
        ownerSurfaceKeys,
        tracedSurfaces,
        explorerParents,
        strictUiPaths,
        size(strictUiPaths) > 0 AS hasStrictUiCallSite
      ORDER BY surface.owner_name, surface.key
    `,
    { objectKey },
  );

  return {
    objectKey,
    rows: rows.map((row) => ({
      surfaceKey: row.surfaceKey,
      surfaceName: row.surfaceName,
      surfaceOwnerKind: row.surfaceOwnerKind,
      surfaceKind: row.surfaceKind,
      surfaceRepoRelativePath: row.surfaceRepoRelativePath,
      functionNames: row.functionNames || [],
      ownerSurfaceKeys: (row.ownerSurfaceKeys || []).filter(Boolean),
      tracedSurfaces: (row.tracedSurfaces || []).filter((surface) => surface?.key),
      explorerParents: (row.explorerParents || []).filter((parent) => parent?.key),
      strictUiPaths: row.strictUiPaths || [],
      hasStrictUiCallSite: Boolean(row.hasStrictUiCallSite),
    })),
  };
}


