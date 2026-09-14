const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { outputPath, publicationOf, publications } = require('./output_layout');

function loadConfig() {
  const configPath = path.resolve(process.env.CAIXIN_CONFIG || './config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
}

function requirePath(value, name) {
  if (!value) throw new Error(`delivery.${name} is required.`);
  return path.resolve(String(value));
}

function issueYear(manifest) {
  const match = String(manifest.title || '').match(/(?:19|20)\d{2}/);
  if (!match) throw new Error(`Cannot determine issue year: ${manifest.title}`);
  return match[0];
}

function buildPublishArgs(config, manifest) {
  const delivery = config.delivery || {};
  if (!delivery.enabled) return null;
  const projectDir = requirePath(delivery.telethonProjectDir, 'telethonProjectDir');
  const script = path.resolve(__dirname, '..', 'scripts', 'publish_issue.py');
  const args = [
    'run', '--project', projectDir, 'python', script,
    '--pdf', outputPath(config, manifest, 'pdf'),
    '--library-dir', requirePath(delivery.libraryDir, 'libraryDir'),
    '--category', publications[publicationOf(manifest)],
    '--year', issueYear(manifest),
    '--credentials-env', requirePath(delivery.credentialsEnv, 'credentialsEnv'),
    '--telegram-config', requirePath(delivery.telegramConfig, 'telegramConfig'),
    '--zotero-config', requirePath(delivery.zoteroConfig, 'zoteroConfig'),
    '--telegram-target', String(delivery.telegramTarget || '').trim()
  ];
  if (!args.at(-1)) throw new Error('delivery.telegramTarget is required.');
  if (delivery.zoteroEnabled === false) args.push('--skip-zotero');
  if (delivery.telegramEnabled === false) args.push('--skip-telegram');
  return args;
}

function publishIssue(issueDir, config = loadConfig()) {
  const fullIssueDir = path.resolve(issueDir);
  const manifestPath = path.join(fullIssueDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  const args = buildPublishArgs(config, manifest);
  if (!args) {
    console.log('Delivery disabled; skip Zotero and Telegram publishing.');
    return;
  }
  const result = spawnSync('uv', args, {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  });
  if (result.error?.code === 'ENOENT') throw new Error('uv command not found; install uv before enabling delivery.');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Issue publishing failed (${result.status ?? result.signal}).`);
}

if (require.main === module) {
  try {
    publishIssue(process.argv[2]);
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = { buildPublishArgs, issueYear, publishIssue };
