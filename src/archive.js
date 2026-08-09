const { spawnSync } = require('child_process');

const issueUrl = process.argv[2];

const fetchResult = spawnSync(process.execPath, ['src/fetch_issue.js', ...(issueUrl ? [issueUrl] : [])], {
  stdio: 'inherit'
});

if (fetchResult.status !== 0) {
  process.exit(fetchResult.status || 1);
}

const buildResult = spawnSync(process.execPath, ['src/build_epub.js'], {
  stdio: 'inherit'
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status || 1);
}

const pdfResult = spawnSync(process.execPath, ['src/build_pdf.js'], {
  stdio: 'inherit'
});

process.exit(pdfResult.status || 0);
