const fs = require('fs');
const path = require('path');

const publications = { caixin: '财新', lifeweek: '三联' };
function publicationOf(manifest) {
  if (publications[manifest.source]) return manifest.source;
  if (/三联|lifeweek\.com\.cn/.test(`${manifest.title} ${manifest.sourceIssueUrl || ''}`)) return 'lifeweek';
  if (/财新|caixin\.com/.test(`${manifest.title} ${manifest.sourceIssueUrl || ''}`)) return 'caixin';
  throw new Error(`Cannot identify publication: ${manifest.title}`);
}
function safeName(value) {
  const result = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!result || result === '.' || result === '..') throw new Error('Invalid issue name');
  return result;
}
function issueFolder(manifest) {
  const match = manifest.title.match(/(\d{4})年\s*第?\s*(\d+)\s*期/);
  if (match) return `${match[1]}年第${match[2].padStart(2, '0')}期`;
  return safeName(manifest.title.replace(/^(财新周刊|三联生活周刊)[ _-]*/, ''));
}
function outputPath(config, manifest, kind, extension) {
  const folder = config.issueLabels?.[manifest.title] || issueFolder(manifest);
  const dir = path.resolve(config.outputDir || './output', publications[publicationOf(manifest)], safeName(folder));
  if (kind === 'dir') return dir;
  const title = safeName(manifest.title);
  const filename = kind === 'cover' ? `封面${extension || '.jpg'}` : kind === 'summary' ? `${title}.summary.txt` : `${title}.${kind}`;
  return path.join(dir, filename);
}
function archivePath(config, manifest) {
  const folder = config.issueLabels?.[manifest.title] || issueFolder(manifest);
  return path.resolve(config.archiveDir || './archive', publications[publicationOf(manifest)], safeName(folder));
}
function listIssues(config, publication) {
  const root = path.resolve(config.archiveDir || './archive');
  if (!fs.existsSync(root)) return [];
  const dirs = Object.entries(publications).filter(([key]) => !publication || key === publication).flatMap(([, name]) => {
    const parent = path.join(root, name);
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(parent, e.name));
  });
  return dirs.flatMap(dir => {
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) return [];
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (publication && publicationOf(manifest) !== publication) return [];
    return [{ dir, manifest, mtime: fs.statSync(file).mtimeMs }];
  }).sort((a, b) => b.mtime - a.mtime);
}
function newestIssueDir(config) {
  const issue = listIssues(config)[0];
  if (!issue) throw new Error('No captured issue found under archiveDir.');
  return issue.dir;
}
module.exports = { publications, publicationOf, issueFolder, outputPath, archivePath, listIssues, newestIssueDir };
