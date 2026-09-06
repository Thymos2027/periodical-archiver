process.argv.splice(2, 0, 'archive');
try { require('./cli').main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
