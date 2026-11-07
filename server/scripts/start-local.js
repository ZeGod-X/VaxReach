import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const databaseDir = resolve(projectRoot, 'data', 'local-postgres-utf8');
const localPassword = 'vaxreach-local-demo-only';

async function portIsAvailable(port) {
  return new Promise(resolvePort => {
    const probe = createServer();
    probe.once('error', () => resolvePort(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePort(true)));
  });
}

async function choosePort(preferredPort, variableName) {
  if (process.env[variableName]) {
    const requested = Number(process.env[variableName]);
    if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
      throw new Error(`${variableName} must be a valid TCP port.`);
    }
    if (!await portIsAvailable(requested)) throw new Error(`${variableName} ${requested} is already in use.`);
    return requested;
  }
  for (let port = preferredPort; port < preferredPort + 32 && port <= 65535; port++) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error(`No free port found near ${preferredPort}.`);
}

const databasePort = await choosePort(5432, 'LOCAL_DATABASE_PORT');
const appPort = await choosePort(3000, 'PORT');

await mkdir(resolve(projectRoot, 'data'), { recursive: true });

const postgres = new EmbeddedPostgres({
  databaseDir,
  user: 'vaxreach',
  password: localPassword,
  port: databasePort,
  persistent: true,
  autoRehydrateSymlinks: true,
  initdbFlags: ['--encoding=UTF8'],
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1']
});

let appProcess;
let shuttingDown = false;

function stopApp(signal) {
  if (appProcess && !appProcess.killed) appProcess.kill(signal);
}

process.once('SIGINT', () => {
  shuttingDown = true;
  stopApp('SIGINT');
});
process.once('SIGTERM', () => {
  shuttingDown = true;
  stopApp('SIGTERM');
});

function runNode(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, { cwd: projectRoot, env, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('close', code => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${args.at(-1)} exited with code ${code ?? 'unknown'}.`));
    });
  });
}

try {
  try {
    await access(resolve(databaseDir, 'PG_VERSION'));
  } catch {
    await postgres.initialise();
  }

  await postgres.start();
  const client = postgres.getPgClient();
  await client.connect();
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['vaxreach']);
  await client.end();
  if (!existing.rowCount) await postgres.createDatabase('vaxreach');

  const appEnv = {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(appPort),
    DATABASE_URL: `postgres://vaxreach:${localPassword}@127.0.0.1:${databasePort}/vaxreach`,
    SESSION_SECRET: 'vaxreach-local-demo-session-secret-keep-on-this-computer',
    COOKIE_SECURE: 'false',
    DEMO_MODE: 'true'
  };

  if (appPort !== 3000) console.log(`Port 3000 is busy; using port ${appPort} instead.`);
  await runNode(['server/scripts/migrate.js'], appEnv);
  await runNode(['server/scripts/seed-demo.js'], appEnv);

  if (shuttingDown) process.exitCode = 0;
  else {
    console.log(`VaxReach local demo is ready at http://localhost:${appPort}`);
    appProcess = spawn(process.execPath, ['server/src/server.js'], { cwd: projectRoot, env: appEnv, stdio: 'inherit' });
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      appProcess.once('error', rejectExit);
      appProcess.once('close', code => resolveExit(code ?? 1));
    });
    if (!shuttingDown && exitCode !== 0) process.exitCode = exitCode;
  }
} catch (error) {
  console.error('\nCould not start VaxReach locally:', error.message);
  console.error('If a port is already in use, close that app or set LOCAL_DATABASE_PORT / PORT to unused ports.');
  process.exitCode = 1;
} finally {
  try { await postgres.stop(); } catch (error) { console.error('Could not stop local database cleanly:', error.message); }
}
