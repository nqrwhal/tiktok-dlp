import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('container health checks use dependency-aware readiness endpoints', async () => {
  const [backendDockerfile, rewindDockerfile, compose] = await Promise.all([
    source('Dockerfile'),
    source('Dockerfile.web'),
    source('docker-compose.yml'),
  ]);

  assert.match(backendDockerfile, /127\.0\.0\.1:'\+p\+'\/ready/);
  assert.match(rewindDockerfile, /127\.0\.0\.1:3000\/api\/health/);
  assert.match(compose, /rewind-web:[\s\S]*condition: service_healthy/);
  assert.doesNotMatch(rewindDockerfile, /\bsqlite3\b/);
  assert.doesNotMatch(compose, /\bLIVE_DB_PATH\b/);
});

test('production deploy targets the tested commit and backs up before recreation', async () => {
  const [deployScript, deployWorkflow] = await Promise.all([
    source('scripts/deploy-prod.sh'),
    source('.github/workflows/deploy.yml'),
  ]);

  assert.match(deployScript, /TARGET_REF="\$\{DEPLOY_SHA:-origin\/main\}"/);
  assert.match(deployScript, /compose build "\$\{SERVICES\[@\]\}"/);
  assert.match(deployScript, /node scripts\/backup-state\.js/);
  assert.match(deployScript, /compose up -d --no-build --force-recreate "\$\{SERVICES\[@\]\}"/);
  assert.match(deployScript, /export COMPOSE_PROFILES=""/);

  const backupOffset = deployScript.indexOf('node scripts/backup-state.js');
  const recreateOffset = deployScript.indexOf('compose up -d --no-build --force-recreate');
  assert.ok(backupOffset > 0 && recreateOffset > backupOffset);

  assert.match(deployWorkflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(deployWorkflow, /git show "\$target":scripts\/deploy-prod\.sh/);
  assert.match(deployWorkflow, /DEPLOY_SHA="\$target" bash "\$tmp"/);
});

test('CI gates deploys on backend, Rewind, browser, and image checks', async () => {
  const workflow = await source('.github/workflows/ci.yml');

  for (const job of ['backend', 'web', 'browser', 'images']) {
    assert.match(workflow, new RegExp(`^  ${job}:`, 'm'));
  }
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /--project=desktop-chromium --project=mobile-chromium/);
  assert.match(workflow, /docker compose build tiktok-discord-downloader rewind-web/);
  assert.match(workflow, /docker compose config --quiet/);
});
