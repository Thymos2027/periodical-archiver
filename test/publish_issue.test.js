const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildPublishArgs, issueYear } = require('../src/publish_issue');

test('publisher maps issue PDF to the configured library and integrations', () => {
  const config = {
    outputDir: './output',
    delivery: {
      enabled: true,
      libraryDir: './library',
      telethonProjectDir: './telethon',
      credentialsEnv: './telethon/.env',
      telegramConfig: './telethon/config.yaml',
      zoteroConfig: './telethon/config.server.yaml',
      telegramTarget: '@example',
      zoteroEnabled: true,
      telegramEnabled: true
    }
  };
  const manifest = { title: '财新周刊-2026年36期', source: 'caixin' };
  const args = buildPublishArgs(config, manifest);
  assert.equal(args[0], 'run');
  assert.equal(args[args.indexOf('--category') + 1], '财新');
  assert.equal(args[args.indexOf('--year') + 1], '2026');
  assert.equal(args[args.indexOf('--telegram-target') + 1], '@example');
  assert.equal(path.basename(args[args.indexOf('--pdf') + 1]), '财新周刊-2026年36期.pdf');
  assert.equal(path.basename(args[args.indexOf('--epub') + 1]), '财新周刊-2026年36期.epub');
  assert.equal(path.basename(args[args.indexOf('--cover') + 1]), '封面.jpg');
  assert.equal(path.basename(args[args.indexOf('--summary') + 1]), '财新周刊-2026年36期.summary.txt');
  assert.doesNotMatch(args.join(' '), /skip-zotero|skip-telegram/);
});

test('publisher can disable remote integrations and validates the year', () => {
  const config = {
    delivery: {
      enabled: true,
      libraryDir: './library',
      telethonProjectDir: './telethon',
      credentialsEnv: './telethon/.env',
      telegramConfig: './telethon/config.yaml',
      zoteroConfig: './telethon/config.server.yaml',
      telegramTarget: '@example',
      zoteroEnabled: false,
      telegramEnabled: false
    }
  };
  const args = buildPublishArgs(config, { title: '三联生活周刊 2025年第9期', source: 'lifeweek' });
  assert.ok(args.includes('--skip-zotero'));
  assert.ok(args.includes('--skip-telegram'));
  assert.equal(issueYear({ title: '三联生活周刊 2025年第9期' }), '2025');
  assert.throws(() => issueYear({ title: '没有年份' }));
});

test('publisher is disabled unless delivery is explicitly enabled', () => {
  assert.equal(buildPublishArgs({}, { title: '财新周刊-2026年36期', source: 'caixin' }), null);
});
