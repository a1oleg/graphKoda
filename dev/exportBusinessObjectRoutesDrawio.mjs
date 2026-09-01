import process from 'node:process';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8790/';
const DEFAULT_OUTPUT_DIR = 'graph/draw';

function postJson(urlText, body) {
  const url = new URL(urlText);
  const transport = url.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 60_000,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          reject(new Error(`GraphQL request failed with ${response.statusCode} ${response.statusMessage}.`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('GraphQL request timed out after 60s.')));
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

function sanitizeFileName(text) {
  const sanitized = String(text || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'function-business-object-routes';
}

function parseArgs(argv) {
  const args = {
    gatewayUrl: undefined,
    stableId: undefined,
    name: undefined,
    repoRelativePath: undefined,
    ensureFlow: true,
    output: undefined,
    jsonOutput: undefined,
    outputDir: DEFAULT_OUTPUT_DIR,
    basename: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--gateway-url') { args.gatewayUrl = value; i++; }
    else if (arg === '--stable-id') { args.stableId = value; i++; }
    else if (arg === '--name') { args.name = value; i++; }
    else if (arg === '--repo-relative-path') { args.repoRelativePath = value; i++; }
    else if (arg === '--ensure-flow') { args.ensureFlow = value !== 'false'; i++; }
    else if (arg === '--output') { args.output = value; i++; }
    else if (arg === '--json-output') { args.jsonOutput = value; i++; }
    else if (arg === '--output-dir') { args.outputDir = value; i++; }
    else if (arg === '--basename') { args.basename = value; i++; }
  }

  if (!args.stableId && !args.name) {
    throw new Error('Pass --stable-id or --name.');
  }

  return args;
}

async function fetchDiagram({ gatewayUrl, stableId, name, repoRelativePath, ensureFlow }) {
  const result = await postJson(gatewayUrl, {
    query: `
      query ExportBusinessObjectRoutesDiagram(
        $stableId: String
        $name: String
        $repoRelativePath: String
        $ensureFlow: Boolean
      ) {
        functionBusinessObjectRoutesDiagram(
          stableId: $stableId
          name: $name
          repoRelativePath: $repoRelativePath
          ensureFlow: $ensureFlow
        ) {
          available
          error
          routeCount
          nodeCount
          edgeCount
          drawioXml
          payload
          function {
            stableId
            name
            label
            repoRelativePath
          }
        }
      }
    `,
    variables: {
      stableId: stableId || null,
      name: name || null,
      repoRelativePath: repoRelativePath || null,
      ensureFlow,
    },
  });

  if (result?.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join('\n'));
  }

  const diagram = result?.data?.functionBusinessObjectRoutesDiagram;
  if (!diagram?.available) {
    throw new Error(diagram?.error || 'Business object routes diagram not available.');
  }

  return diagram;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gatewayUrl = args.gatewayUrl || DEFAULT_GATEWAY_URL;
  const diagram = await fetchDiagram({
    gatewayUrl,
    stableId: args.stableId,
    name: args.name,
    repoRelativePath: args.repoRelativePath,
    ensureFlow: args.ensureFlow,
  });

  const fn = diagram.function || {};
  const basename = args.basename || sanitizeFileName(`${fn.name || fn.label || 'function'}-business-object-routes`);
  const outputDir = path.resolve(process.cwd(), args.outputDir);
  const drawioPath = path.resolve(args.output || path.join(outputDir, `${basename}.drawio`));
  const jsonPath = path.resolve(args.jsonOutput || path.join(outputDir, `${basename}.json`));

  mkdirSync(path.dirname(drawioPath), { recursive: true });
  mkdirSync(path.dirname(jsonPath), { recursive: true });

  writeFileSync(drawioPath, diagram.drawioXml, 'utf8');
  writeFileSync(jsonPath, diagram.payload, 'utf8');

  console.log(`Fetched functionBusinessObjectRoutesDiagram from ${gatewayUrl} вЂ” ${diagram.routeCount} routes, ${diagram.nodeCount} nodes, ${diagram.edgeCount} edges`);
  console.log(`Wrote draw.io business object routes diagram to ${drawioPath}`);
  console.log(`Wrote payload JSON to ${jsonPath}`);
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exitCode = 1;
});
