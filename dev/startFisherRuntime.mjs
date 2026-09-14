import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createClient } from 'redis';

const redisUrl = process.env.RUNTIME_REDIS_URL || 'redis://127.0.0.1:6379';
const redis = createClient({ url: redisUrl, socket: { connectTimeout: 2000, reconnectStrategy: false } });
redis.on('error', () => {});
let redisReady = false;
try {
  await redis.connect();
  redisReady = await redis.ping() === 'PONG';
} catch {} finally {
  if (redis.isOpen) await redis.disconnect();
}
if (!redisReady) {
  execFileSync('docker', ['compose', '-f', 'docker-compose.redis.yml', 'up', '-d'], { windowsHide: true, stdio: 'inherit' });
}
const ready = async () => {
  try { return (await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(2000) })).ok; }
  catch { return false; }
};
if (!await ready()) {
  const dir = path.resolve('tmp/fisher-yates/runtime');
  fs.mkdirSync(dir, { recursive: true });
  const out = fs.openSync(path.join(dir, 'relay.log'), 'a');
  const err = fs.openSync(path.join(dir, 'relay.err'), 'a');
  const child = spawn(process.execPath, ['dev/redis/startRuntimeRelayToRedis.mjs'], {
    cwd: process.cwd(), detached: true, windowsHide: true,
    env: { ...process.env, RUNTIME_REDIS_URL: redisUrl, RUNTIME_STORAGE_BACKEND: 'redis' },
    stdio: ['ignore', out, err],
  });
  child.unref(); fs.closeSync(out); fs.closeSync(err);
  for (let i = 0; i < 30 && !await ready(); i++) await new Promise(resolve => setTimeout(resolve, 500));
  if (!await ready()) throw new Error('Runtime relay did not become healthy; inspect tmp/fisher-yates/runtime/relay.err');
}
console.log('Runtime ready. Swagger: http://127.0.0.1:8787/api/docs');
