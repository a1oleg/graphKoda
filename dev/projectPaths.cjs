const fs = require('node:fs');
const path = require('node:path');

const toolRoot = path.resolve(__dirname, '..');
const configPath = process.env.COLDKODE_PROJECT_CONFIG || path.join(toolRoot, 'coldkode.local.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const sourceRoot = path.resolve(toolRoot, process.env.COLDKODE_SOURCE_ROOT || config.sourceRoot || '.');
const dataRoot = path.resolve(toolRoot, process.env.COLDKODE_DATA_ROOT || config.dataRoot || '.coldkode-data');

module.exports = { toolRoot, sourceRoot, dataRoot };
