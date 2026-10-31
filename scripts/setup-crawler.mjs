import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const root = resolve(import.meta.dirname, '..'), bundled = resolve(root, 'collector/browser-runtime');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--runtime' || !args[1])) {
  console.error('Usage: npm run crawler:install -- [--runtime /persistent/browser-runtime]'); process.exit(1);
}
if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24+ required'); process.exit(1); }
const runtimeDir = resolve(args[1] || bundled), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
await mkdir(runtimeDir, { recursive: true });
if (runtimeDir !== bundled) for (const name of ['package.json', 'package-lock.json']) await copyFile(resolve(bundled, name), resolve(runtimeDir, name));
const env = { ...process.env, VANTIS_CRAWLER_RUNTIME_DIR: runtimeDir };
const run = (command, argv, extraEnv = env) => new Promise(resolveExit => {
  const child = spawn(command, argv, { cwd: runtimeDir, env: extraEnv, stdio: 'inherit' });
  child.once('error', () => resolveExit(1)); child.once('exit', code => resolveExit(code ?? 1));
});
const installed = await run(npm, ['ci', '--ignore-scripts', '--no-fund']);
if (installed) process.exit(installed);
const { browserRuntime } = await import('../collector/browser.mjs');
const runtime = await browserRuntime({ env: { ...env, VANTIS_CRAWLER_ENGINE: 'auto' } });
if (runtime.metadata.reason === 'browser_not_installed') {
  // Playwright downloads the browser matching this locked version and current OS/architecture.
  // OS package installation is left to the host package manager / container image.
  env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(runtimeDir, 'browsers');
  const code = await run(process.execPath, [resolve(runtimeDir, 'node_modules/playwright/cli.js'), 'install', 'chromium']);
  if (code) process.exit(code);
  console.log(`Set PLAYWRIGHT_BROWSERS_PATH=${env.PLAYWRIGHT_BROWSERS_PATH} for the collector service.`);
}
console.log(`Set VANTIS_CRAWLER_RUNTIME_DIR=${runtimeDir} for persistent deployments.`);
process.exitCode = await run(process.execPath, [resolve(root, 'collector/browser.mjs')]);
