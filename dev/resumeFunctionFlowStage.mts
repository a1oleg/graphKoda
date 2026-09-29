import { FunctionFlowDuckdbStage } from '../graph/static-extract/ts/functionFlowDuckdbStage.ts';

const [databasePath, parquetDir, confirmedProvenanceId] = process.argv.slice(2);
if (!databasePath || !parquetDir || !confirmedProvenanceId) {
  throw new Error('Usage: resumeFunctionFlowStage.mts databasePath parquetDir confirmedProvenanceId. Requires explicit confirmation that extractor changes only committed existing content.');
}
const stage = await FunctionFlowDuckdbStage.resume(databasePath, parquetDir, confirmedProvenanceId);
try {
  console.log(JSON.stringify(await stage.finalize()));
} finally {
  stage.close();
}
