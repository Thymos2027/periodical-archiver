const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { outputPath, publicationOf, issueFolder } = require('../src/output_layout');
const { parseArgs } = require('../src/cli');
const { buildPrompt, findWindowsCodexDesktopBin } = require('../src/build_summary');
const fs = require('node:fs');
const os = require('node:os');
const { archivePath, listIssues } = require('../src/output_layout');
test('archive paths use publication/year and verified historical labels', () => {
  assert.equal(archivePath({}, { title: '三联生活周刊 2026年第35期 在大学 这样成人' }), path.resolve('archive/三联/2026年第35期'));
  assert.equal(archivePath({ issueLabels: { '财新周刊_2026-03-15': '2026年第09期' } }, { title: '财新周刊_2026-03-15' }), path.resolve('archive/财新/2026年第09期'));
});
test('issue discovery uses persistent archive and excludes temporary data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-layout-test-'));
  const parent = path.join(root, '财新');
  const dir = path.join(parent, '2026年第35期');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({ title: '财新周刊-2026年35期' }));
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); fs.rmdirSync(parent); fs.rmdirSync(root); });
  const config = { archiveDir: root, tempDir: '/unused-temp' };
  assert.equal(listIssues(config, 'caixin')[0].dir, dir);
  assert.equal(listIssues(config, 'lifeweek').length, 0);
});
test('separate publications and text/summary; keep five formats together', () => {
  const a = { title: '财新周刊-2026年35期' };
  const b = { title: '三联生活周刊 2026年第35期 在大学 这样成人' };
  assert.equal(outputPath({}, a, 'dir'), path.resolve('output/财新/2026年第35期'));
  assert.equal(outputPath({}, b, 'dir'), path.resolve('output/三联/2026年第35期'));
  assert.notEqual(outputPath({}, a, 'txt'), outputPath({}, a, 'summary'));
  assert.equal(path.dirname(outputPath({}, a, 'cover', '.png')), outputPath({}, a, 'dir'));
});
test('year, padded issue and verified historical override', () => {
  assert.equal(issueFolder({ title: '财新周刊-2025年8期' }), '2025年第08期');
  assert.throws(() => publicationOf({ title: 'unknown' }));
  assert.equal(outputPath({ issueLabels: { old: '2026年第09期' } }, { title: 'old', source: 'caixin' }, 'dir'), path.resolve('output/财新/2026年第09期'));
});
test('explicit publication and options', () => {
  assert.equal(parseArgs(['--publication', '三联', 'url', '--resume']).publication, 'lifeweek');
  assert.equal(parseArgs(['--publication=caixin', '--all']).all, true);
  assert.throws(() => parseArgs(['url']));
  assert.throws(() => parseArgs(['--publication', 'other']));
  assert.throws(() => parseArgs(['--publication', 'caixin', '--typo']));
});
test('summary uses actual publication', () => {
  const prompt = buildPrompt({ issueTitle: '三联生活周刊 2026年第35期', articleCount: 26, digest: 'test' }, 200);
  assert.match(prompt, /三联生活周刊/);
  assert.doesNotMatch(prompt, /财新周刊/);
});
test('summary finds the newest Codex desktop CLI on Windows', t => {
  if (process.platform !== 'win32') return t.skip('Windows-only Codex desktop layout');
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-test-'));
  const oldBin = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'old', 'codex.exe');
  const newBin = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'new', 'codex.exe');
  fs.mkdirSync(path.dirname(oldBin), { recursive: true });
  fs.mkdirSync(path.dirname(newBin), { recursive: true });
  fs.writeFileSync(oldBin, 'old');
  fs.writeFileSync(newBin, 'new');
  fs.utimesSync(oldBin, new Date(1_000), new Date(1_000));
  fs.utimesSync(newBin, new Date(2_000), new Date(2_000));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  assert.equal(findWindowsCodexDesktopBin({ LOCALAPPDATA: localAppData }), newBin);
});
