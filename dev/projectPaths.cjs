const fs = require('node:fs');
const path = require('node:path');

const toolRoot = path.resolve(__dirname, '..');
const configPath = process.env.graphKoda_PROJECT_CONFIG || path.join(toolRoot, 'graphKoda.local.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const sourceRoot = path.resolve(toolRoot, process.env.graphKoda_SOURCE_ROOT || config.sourceRoot || '.');
const dataRoot = path.resolve(toolRoot, process.env.graphKoda_DATA_ROOT || config.dataRoot || '.graphKoda-data');
const sourceExcludePaths = config.sourceExcludePaths || [];
if (!Array.isArray(sourceExcludePaths) || sourceExcludePaths.some(value => typeof value !== 'string' || !value.trim())) {
  throw new Error('sourceExcludePaths must be an array of non-empty source-relative directory paths');
}

module.exports = { toolRoot, sourceRoot, dataRoot, sourceExcludePaths };
