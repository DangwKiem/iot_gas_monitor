import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

// This runner creates and removes only its own disposable PostgreSQL container.
const name = `iot-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const run = (command: string, args: string[], env = process.env) =>
  execFileSync(command, args, { env, stdio: 'inherit' });
let created = false;
try {
  run('docker', [
    'run',
    '-d',
    '--name',
    name,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=iot_test',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  ]);
  created = true;
  const portOutput = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' });
  const port = portOutput.trim().split(':').at(-1);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      execFileSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'iot_test'], {
        stdio: 'ignore',
      });
      ready = true;
      break;
    } catch {
      await setTimeout(1000);
    }
  }
  if (!ready) throw new Error('PostgreSQL test container did not become ready');
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/iot_test`;
  const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url };
  run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], env);
  run(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      process.argv.includes('--browser')
        ? 'tests/e2e'
        : process.argv.includes('--load')
          ? 'tests/performance'
          : 'apps/api/tests',
    ],
    env,
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.replaceAll(password, '[REDACTED]')
      : 'Integration test failed',
  );
  process.exitCode = 1;
} finally {
  if (created) run('docker', ['rm', '-f', name]);
}
