import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createScene,readScene} from '../graph/scene/scene.mjs';
import {fisherYatesRoot} from './fisherYatesConfig.mjs';
const file=fileURLToPath(new URL('../graph/draw/scenes/fisher.drawio',import.meta.url));
try {await access(file);}catch(e){if(e.code!=='ENOENT')throw e;await createScene({sceneId:'fisher',rootStableId:fisherYatesRoot});}
console.log(JSON.stringify(await readScene('fisher')));
