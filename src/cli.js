const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { publications, publicationOf, listIssues, outputPath } = require('./output_layout');

function parseArgs(args) {
  const result = { positional: [], resume: false, all: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--publication') result.publication = args[++i];
    else if (arg.startsWith('--publication=')) result.publication = arg.split('=')[1];
    else if (arg === '--resume') result.resume = true;
    else if (arg === '--all') result.all = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else result.positional.push(arg);
  }
  result.publication = ({ 财新: 'caixin', 三联: 'lifeweek' })[result.publication] || result.publication;
  if (!result.help && !publications[result.publication]) throw new Error('Specify --publication caixin or --publication lifeweek (also 财新 / 三联).');
  if (result.positional.length > 1) throw new Error('Only one URL or issue directory is supported.');
  return result;
}
function run(script, args, env = process.env) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit', env, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (${result.status ?? result.signal}).`);
}
function main() {
  const action = process.argv[2];
  const options = parseArgs(process.argv.slice(3));
  if (options.help) {
    console.log('pnpm run archive -- --publication <caixin|lifeweek> <issue-url> [--resume]\npnpm run fetch -- --publication <caixin|lifeweek> <issue-url> [--resume]\npnpm run build:epub|build:pdf|build:txt|build:summary -- --publication <caixin|lifeweek> [issue-directory]\npnpm run build:summary -- --publication <caixin|lifeweek> --all\npnpm run publish -- --publication <caixin|lifeweek> [issue-directory]');
    return;
  }
  const config = JSON.parse(fs.readFileSync(process.env.CAIXIN_CONFIG || 'config.json', 'utf8').replace(/^\uFEFF/, ''));
  if (['fetch', 'archive'].includes(action)) {
    if (options.all) throw new Error('--all is only supported for summaries.');
    const url = options.positional[0];
    const host = new URL(url).hostname;
    if (!(options.publication === 'caixin' ? /(^|\.)caixin\.com$/.test(host) : host === 'www.lifeweek.com.cn')) throw new Error('URL does not match the selected publication.');
    const receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'periodical-run-'));
    const receipt = path.join(receiptDir, 'result.json');
    try {
      run(options.publication === 'caixin' ? 'fetch_issue.js' : 'fetch_lifeweek.js', [url, ...(options.resume ? ['--resume'] : [])], { ...process.env, ARCHIVE_RESULT_FILE: receipt });
      const { issueDir } = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      const manifest = JSON.parse(fs.readFileSync(path.join(issueDir, 'manifest.json'), 'utf8'));
      if (publicationOf(manifest) !== options.publication) throw new Error('Captured publication mismatch.');
      if (action === 'archive') {
        for (const kind of ['epub', 'pdf', 'txt']) run(`build_${kind}.js`, [issueDir]);
        run('build_summary.js', [outputPath(config, manifest, 'txt')]);
        if (config.delivery?.enabled) run('publish_issue.js', [issueDir]);
      }
    } finally {
      if (fs.existsSync(receipt)) fs.unlinkSync(receipt);
      fs.rmdirSync(receiptDir);
    }
    return;
  }
  if (action === 'publish') {
    if (options.resume || options.all) throw new Error('Unsupported option for publish.');
    let issue;
    if (options.positional[0]) {
      const dir = path.resolve(options.positional[0]);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (publicationOf(manifest) !== options.publication) throw new Error('Issue directory does not match publication.');
      issue = { dir, manifest };
    } else {
      issue = listIssues(config, options.publication)[0];
    }
    if (!issue) throw new Error('No captured issue found for this publication.');
    run('publish_issue.js', [issue.dir]);
    return;
  }
  const kind = action.replace(/^build:/, '');
  if (!['epub', 'pdf', 'txt', 'summary'].includes(kind)) throw new Error(`Unknown action: ${action}`);
  if (options.resume || (options.all && kind !== 'summary')) throw new Error('Unsupported option for this build command.');
  let issues;
  if (options.positional[0]) {
    const dir = path.resolve(options.positional[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (publicationOf(manifest) !== options.publication) throw new Error('Issue directory does not match publication.');
    issues = [{ dir, manifest }];
  } else issues = listIssues(config, options.publication);
  if (!issues.length) throw new Error('No captured issue found for this publication.');
  for (const issue of options.all ? issues : issues.slice(0, 1)) run(`build_${kind}.js`, [kind === 'summary' ? outputPath(config, issue.manifest, 'txt') : issue.dir]);
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { parseArgs, main };
