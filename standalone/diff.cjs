const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildDiffRows } = require('../lib/engine.cjs');

(async () => {
    const { dir, left, right } = workerData;
    const [a, b] = await Promise.all([left, right].map((id) => fs.readFile(path.join(dir, 'codes', `${id}.txt`), 'utf8')));
    parentPort.postMessage({ rows: buildDiffRows(a, b) });
})().catch((error) => parentPort.postMessage({ error: error.message }));
