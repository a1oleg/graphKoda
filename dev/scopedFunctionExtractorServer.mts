import http from 'node:http';
import path from 'node:path';
import projectPaths from './projectPaths.cjs';
import {captureExtractionProvenance, assertExtractionUnchanged, gitIdentity} from './extractionProvenance.mjs';

import chokidar, { type FSWatcher } from 'chokidar';
import type ts from 'typescript';

import {
  createFunctionFlowExtractionContext,
  extractFunctionFlowGraphs,
  payloadForTransport,
  type FunctionFlowExtractionContext,
} from '../graph/static-extract/ts/fromASTtoPreGraphFlow.ts';
import {
  createProgram,
  refreshSourceStateId,
} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const workspaceRoot = projectPaths.sourceRoot;
const host = '127.0.0.1';
const port = Number(process.env.GRAPH_SCOPED_EXTRACTOR_PORT || 8794);
const protocolVersion = 1;

let program: ts.Program | undefined;
let context: FunctionFlowExtractionContext | undefined;
let sourceWatcher: FSWatcher | undefined;
let sourceDirty = false;
let requestCount = 0;
let contextProvenanceId = '';
const loadedProvenance = captureExtractionProvenance();

function jsonResponse(response: http.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('Scoped extractor request is too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

async function watchProgramSources(nextProgram: ts.Program) {
  const rootNames = nextProgram.getRootFileNames().map((fileName) => path.resolve(fileName));
  const sourceRoots = [...new Set(rootNames.flatMap((fileName) => {
    const relative = path.relative(workspaceRoot, fileName);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
    const [topLevel] = relative.split(path.sep);
    if (!topLevel || ['graph', 'node_modules', 'tmp'].includes(topLevel)) return [];
    return [path.join(workspaceRoot, topLevel)];
  }))];
  const watchTargets = [...rootNames, ...sourceRoots];
  if (!sourceWatcher) {
    sourceWatcher = chokidar.watch(watchTargets, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    });
    sourceWatcher.on('all', () => {
      sourceDirty = true;
      context = undefined;
    });
    return;
  }
  sourceWatcher.add(watchTargets);
}

async function ensureContext() {
  const reusedProgram = Boolean(program);
  if (!program || sourceDirty) {
    // The extractor module remains loaded across source edits, so provenance
    // must be refreshed explicitly together with the incremental Program.
    refreshSourceStateId();
    program = createProgram(program);
    sourceDirty = false;
    context = undefined;
    await watchProgramSources(program);
  }
  const reusedContext = Boolean(context);
  if (!context) context = createFunctionFlowExtractionContext(program);
  return { reusedProgram, reusedContext };
}

const extractorWatcher = chokidar.watch([
  path.join(projectPaths.toolRoot, 'graph', 'static-extract', 'ts'),
  path.join(projectPaths.toolRoot, 'dev', 'scopedFunctionExtractorServer.mts'),
  path.join(projectPaths.toolRoot, 'dev', 'extractionProvenance.mjs'),
  path.join(projectPaths.toolRoot, 'dev', 'projectPaths.cjs'),
  path.join(workspaceRoot, 'tsconfig.json'),
], { ignoreInitial: true });
extractorWatcher.on('all', () => {
  // Imported extractor modules cannot be hot-reloaded safely. Let the next
  // scoped import start a process containing the new implementation.
  setTimeout(() => process.exit(0), 50).unref();
});

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const identity = gitIdentity(projectPaths.toolRoot);
      jsonResponse(response, 200, {
        ok: true,
        provenanceSupported: true,
        toolRoot: projectPaths.toolRoot,
        extractorCurrent: identity.commit === loadedProvenance.extractor_commit
          && identity.dirtyFingerprint === loadedProvenance.extractor_dirty_fingerprint,
        protocolVersion,
        pid: process.pid,
        contextReady: Boolean(context),
        sourceDirty,
        requestCount,
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/shutdown') {
      jsonResponse(response, 200, { ok: true });
      setTimeout(() => process.exit(0), 25).unref();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/extract') {
      jsonResponse(response, 404, { ok: false, error: 'Not found.' });
      return;
    }

    const body = await readJson(request);
    const fnStableId = String(body.fnStableId || '').trim();
    if (!fnStableId) {
      jsonResponse(response, 400, { ok: false, error: 'fnStableId is required.' });
      return;
    }

    const started = performance.now();
    const provenance = captureExtractionProvenance();
    if (provenance.extractor_commit !== loadedProvenance.extractor_commit
      || provenance.extractor_dirty_fingerprint !== loadedProvenance.extractor_dirty_fingerprint) {
      throw new Error('Extractor checkout changed; restart the scoped extractor before importing.');
    }
    if (contextProvenanceId !== provenance.id) sourceDirty = true;
    const reuse = await ensureContext();
    contextProvenanceId = provenance.id;
    if (body.includeParameterOrigins !== undefined && typeof body.includeParameterOrigins !== 'boolean') {
      throw new Error('includeParameterOrigins must be a boolean.');
    }
    const payload = extractFunctionFlowGraphs(program!, fnStableId, context, {
      includeParameterOrigins: body.includeParameterOrigins === true,
    });
    requestCount += 1;
    response.setHeader('X-Graph-Extractor-Elapsed-Ms', String(Math.round(performance.now() - started)));
    response.setHeader('X-Graph-Extractor-Reused-Program', String(reuse.reusedProgram));
    response.setHeader('X-Graph-Extractor-Reused-Context', String(reuse.reusedContext));
    assertExtractionUnchanged(provenance);
    jsonResponse(response, 200, payloadForTransport(payload, provenance));
  } catch (error) {
    jsonResponse(response, 500, {
      ok: false,
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  process.stderr.write(`[graph:scoped-extractor] listening=http://${host}:${port} protocol=${protocolVersion}\n`);
});

async function close() {
  await Promise.allSettled([
    new Promise<void>((resolve) => server.close(() => resolve())),
    extractorWatcher.close(),
    sourceWatcher?.close() || Promise.resolve(),
  ]);
}

process.once('SIGINT', () => void close().finally(() => process.exit(0)));
process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
