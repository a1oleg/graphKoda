import dotenv from 'dotenv';

let loaded = false;

export function loadProjectEnv() {
  if (loaded) {
    return;
  }

  dotenv.config({ path: '.env', quiet: true });
  dotenv.config({ path: 'graph/.env', override: true, quiet: true });

  loaded = true;
}

export function resolveProjectGitRevision() {
  return process.env.PROBE_GIT_REVISION
    || process.env.APP_REVISION
    || process.env.GITHUB_SHA?.trim().slice(0, 7)
    || process.env.GIT_COMMIT?.trim().slice(0, 7)
    || process.env.SOURCE_VERSION?.trim().slice(0, 7)
    || 'unknown';
}
