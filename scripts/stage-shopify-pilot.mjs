import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedSuffixes = new Set(['.toml', '.liquid', '.json', '.js', '.mjs', '.ts', '.tsx', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2']);
const excludedDirectories = new Set(['node_modules', 'dist', 'build', 'coverage']);

function requireCondition(value, message) { if (!value) throw new Error(message); }
function field(content, name) {
  const matches = [...content.matchAll(new RegExp(`^${name}\\s*=\\s*"([^"\\r\\n]+)"\\s*(?:#.*)?$`, 'gm'))];
  requireCondition(matches.length <= 1, `Duplicate ${name} fields are unsupported.`);
  return matches[0]?.[1];
}
async function optional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function contained(root, path) {
  const rel = relative(root, path);
  requireCondition(rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel), 'Stage path escaped its intended root.');
}
async function safeDirectory(path, root) {
  contained(root, path);
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { requireCondition(!(await lstat(current)).isSymbolicLink(), 'Staging through symbolic links is not supported.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(current); }
  }
  contained(await realpath(root), await realpath(path));
}
async function safeWrite(path, content, root) {
  await safeDirectory(dirname(path), root);
  try { requireCondition(!(await lstat(path)).isSymbolicLink(), 'Refusing to overwrite a symbolic link.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(path, content, { mode: 0o600 });
}
async function sourceFiles(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || excludedDirectories.has(entry.name)) continue;
    requireCondition(!entry.isSymbolicLink(), 'Extension sources must not contain symbolic links.');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path, base));
    else if (entry.isFile() && allowedSuffixes.has(extname(entry.name).toLowerCase())) {
      requireCondition(!/(?:secret|credential|token|password|\.env)/i.test(entry.name), 'Credential-like extension filenames are not staged.');
      result.push({ path, relative: relative(base, path) });
    }
  }
  return result;
}

/** Local files only: no CLI, network, environment loading, installation, build, or deployment. */
export async function stageShopifyPilot(pilot, root = repository) {
  requireCondition(/^[a-z][a-z0-9-]{0,39}$/.test(pilot ?? ''), 'Usage: node scripts/stage-shopify-pilot.mjs <pilot>');
  root = await realpath(root);
  const example = await readFile(join(root, 'deploy', pilot, 'shopify.app.toml.example'), 'utf8');
  const shop = field(example, 'dev_store_url');
  const appName = field(example, 'name');
  requireCondition(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop ?? '') && appName, 'The pilot example must name its app and canonical store.');
  requireCondition(!field(example, 'client_id'), 'Keep the pilot example unlinked; the staged config holds its public client ID.');
  const callbackMatch = example.match(/^redirect_urls\s*=\s*\["([^"\r\n]+)"\]\s*$/m);
  const callback = new URL(callbackMatch?.[1] ?? 'invalid');
  requireCondition(callback.protocol === 'https:' && !callback.username && !callback.password && !callback.search && !callback.hash, 'Use one canonical HTTPS OAuth callback in the pilot example.');
  const registrationText = await optional(join(root, 'deploy', pilot, 'registration.json'));
  const registration = registrationText ? JSON.parse(registrationText) : undefined;
  if (registration) {
    requireCondition(registration.format === 1 && registration.pilot === pilot && registration.shop === shop
      && registration.appName === appName && registration.callbackUrl === callback.href
      && /^[a-f0-9]{32}$/i.test(registration.clientId ?? '') && /^\d+$/.test(registration.appId ?? '')
      && /^\d+$/.test(registration.organizationId ?? '') && registration.extensions && typeof registration.extensions === 'object',
    'Public pilot registration does not match the pilot example.');
  }
  const rootConfig = await readFile(join(root, 'shopify.app.toml'), 'utf8');
  const rootClientId = field(rootConfig, 'client_id');
  const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const dataRoot = join(root, '.data');
  await safeDirectory(dataRoot, root);
  const target = join(dataRoot, `${pilot}-shopify`);
  await safeDirectory(target, dataRoot);
  const markerPath = join(target, 'pilot-stage.json');
  const existingMarkerText = await optional(markerPath);
  const existingFiles = await readdir(target);
  requireCondition(existingMarkerText || existingFiles.length === 0, 'Existing staging folder has no ownership marker; review it manually before staging.');
  if (existingMarkerText) {
    const marker = JSON.parse(existingMarkerText);
    requireCondition(marker.format === 1 && marker.pilot === pilot && marker.shop === shop, 'Staging folder belongs to a different pilot.');
  }
  const configFile = `shopify.app.${pilot}.toml`;
  const previousNamedApp = await optional(join(target, configFile));
  const previousDefaultApp = await optional(join(target, 'shopify.app.toml'));
  const namedClientId = previousNamedApp && field(previousNamedApp, 'client_id');
  const defaultClientId = previousDefaultApp && field(previousDefaultApp, 'client_id');
  requireCondition(!namedClientId || !defaultClientId || namedClientId === defaultClientId, 'Named and default staged configs have conflicting app identities.');
  const existingClientId = namedClientId || defaultClientId;
  requireCondition(!existingClientId || !registration || existingClientId === registration.clientId, 'Staged app identity conflicts with the registered pilot.');
  const clientId = existingClientId || registration?.clientId;
  if (clientId) requireCondition(/^[a-f0-9]{32}$/i.test(clientId) && clientId !== rootClientId, 'Refusing to reuse the root app identity for this pilot.');
  for (const previousApp of [previousNamedApp, previousDefaultApp].filter(Boolean)) {
    const previousShop = field(previousApp, 'dev_store_url');
    // config link can omit dev_store_url; an explicitly different store is never accepted.
    requireCondition(field(previousApp, 'name') === appName && (!previousShop || previousShop === shop), 'Existing staged app identity does not match the pilot example.');
  }

  const sourceRoot = join(root, 'extensions');
  const extensions = (await readdir(sourceRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  const prepared = [];
  for (const extension of extensions) {
    const source = await readFile(join(sourceRoot, extension.name, 'shopify.extension.toml'), 'utf8');
    prepared.push({ name: extension.name, source, files: await sourceFiles(join(sourceRoot, extension.name)) });
  }
  let preservedUids = 0;
  let restoredUids = 0;
  for (const extension of prepared) {
    const previous = await optional(join(target, 'extensions', extension.name, 'shopify.extension.toml'));
    const previousUid = previous && field(previous, 'uid');
    const registeredUid = registration?.extensions[extension.name]?.uid;
    requireCondition(!previousUid || !registeredUid || previousUid === registeredUid, 'Staged extension UID conflicts with the registered pilot.');
    const uid = previousUid || registeredUid;
    if (uid) {
      requireCondition(clientId && /^[a-z0-9-]{16,100}$/i.test(uid), 'An extension UID requires a linked, separate staged pilot app.');
      // UIDs are source-defined and app-scoped: the same handle can legitimately
      // generate the same UID in multiple apps. The client ID separates the apps.
      // https://shopify.dev/docs/apps/build/dev-dashboard/migrate-from-partners
      extension.uid = uid;
      if (previousUid) preservedUids++;
      else restoredUids++;
    }
  }
  const copiedFiles = prepared.flatMap(extension => extension.files.map(file => join('extensions', extension.name, file.relative).replaceAll('\\', '/')));
  if (existingMarkerText) {
    const marker = JSON.parse(existingMarkerText);
    requireCondition(!marker.copiedFiles?.some(path => !copiedFiles.includes(path)), 'Previously staged sources were removed upstream; review and remove stale staged files before refreshing.');
  }
  // Ownership marker precedes writes so an interrupted first run can be retried.
  await safeWrite(markerPath, `${JSON.stringify({ format: 1, pilot, shop, copiedFiles }, null, 2)}\n`, target);
  for (const extension of prepared) {
    for (const file of extension.files) {
      let content = await readFile(file.path);
      if (file.relative === 'shopify.extension.toml') {
        const withoutUid = extension.source.replace(/^uid\s*=.*(?:\r?\n|$)/gm, '');
        content = Buffer.from(`${extension.uid ? `uid = "${extension.uid}"\n` : ''}${withoutUid}`);
      }
      await safeWrite(join(target, 'extensions', extension.name, file.relative), content, target);
    }
  }
  const stagedApp = `${clientId ? `client_id = "${clientId}"\n` : ''}${example}`;
  // The named config is canonical for --file-name/--config. Keep the default copy
  // aligned for initial CLI discovery, without introducing a second app identity.
  await safeWrite(join(target, configFile), stagedApp, target);
  await safeWrite(join(target, 'shopify.app.toml'), stagedApp, target);
  const packageJson = {
    name: `${pilot}-sales-pilot-deployment`, version: '0.0.0', private: true, type: 'module',
    packageManager: rootPackage.packageManager, workspaces: ['extensions/*'],
    scripts: { build: 'node scripts/verify-staged.mjs', dev: 'node scripts/no-local-dev.mjs' },
    dependencies: { '@shopify/web-pixels-extension': rootPackage.devDependencies['@shopify/web-pixels-extension'] },
    devDependencies: { '@shopify/cli': rootPackage.devDependencies['@shopify/cli'] },
  };
  await safeWrite(join(target, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, target);
  await safeWrite(join(target, 'pnpm-workspace.yaml'), "packages:\n  - 'extensions/*'\n", target);
  await safeWrite(join(target, 'shopify.web.toml'), `roles = ["frontend", "backend"]\nauth_callback_path = ["${callback.pathname}"]\nwebhooks_path = "/webhooks"\n\n[commands]\ndev = "node scripts/no-local-dev.mjs"\nbuild = "node scripts/verify-staged.mjs"\n`, target);
  await safeWrite(join(target, 'scripts', 'verify-staged.mjs'), `import { stat } from 'node:fs/promises';\nfor (const file of ['extensions/sales-assistant/assets/sales-assistant.js', 'extensions/sales-assistant/assets/sales-assistant-ui.js', 'extensions/sales-analytics/src/index.ts']) {\n  if (!(await stat(file)).size) throw new Error('Build shared assets in the repository, then stage again.');\n}\nconsole.log('Staged shared extension assets verified. Backend deployment is separate.');\n`, target);
  await safeWrite(join(target, 'scripts', 'no-local-dev.mjs'), "console.error('This folder is for extension deployment only. Use the repository for backend development.');\nprocess.exitCode = 1;\n", target);
  return { pilot, shop, target, configFile, extensions: prepared.length, preservedUids, restoredUids, linked: Boolean(clientId), stagedFiles: prepared.reduce((sum, item) => sum + item.files.length, 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCondition(process.argv.length === 3, 'Usage: node scripts/stage-shopify-pilot.mjs <pilot>');
    console.log(JSON.stringify(await stageShopifyPilot(process.argv[2]), null, 2));
  } catch (error) {
    // Report our own bounded operational messages, never arbitrary file contents or CLI output.
    console.error(error instanceof Error && !['SyntaxError', 'TypeError'].includes(error.name) ? error.message : 'Staging failed: check the pilot files and ownership marker.');
    process.exitCode = 1;
  }
}
