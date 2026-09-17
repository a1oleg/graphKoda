// One step at a time; token stays on this machine and is never printed.
import fs from 'node:fs/promises';
import {bridge} from '../graph/presentation/presentation.mjs';
const input = JSON.parse(process.argv[2] === '--file' ? await fs.readFile(process.argv[3], 'utf8') : process.argv[2] || '{}');
const result = await bridge(input);
console.log(JSON.stringify(result,null,2));
