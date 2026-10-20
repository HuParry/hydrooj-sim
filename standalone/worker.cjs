const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readArchive } = require('./archive.cjs');
const { runJPlag, USE_BUNDLED_JAVA } = require('../lib/engine.cjs');

async function run() {
    const { dir, threshold, timeout } = workerData;
    const records = readArchive(await fs.readFile(path.join(dir, 'upload.zip')));
    await fs.rm(path.join(dir, 'upload.zip'));
    await fs.mkdir(path.join(dir, 'codes'));
    const groups = new Map();
    const problems = new Map();
    for (const record of records) {
        if (!problems.has(record.pid)) problems.set(record.pid, { pid: record.pid, recordCount: 0, pairs: [], errors: [] });
        problems.get(record.pid).recordCount++;
        const key = `${record.pid}\0${record.profile.family}`;
        if (!groups.has(key)) groups.set(key, { pid: record.pid, profile: record.profile, records: [] });
        groups.get(key).records.push(record);
        await fs.writeFile(path.join(dir, 'codes', `${record.id}.txt`), record.code);
    }
    const comparable = [...groups.values()].filter((group) => new Set(group.records.map((record) => record.uid)).size >= 2);
    parentPort.postMessage({ state: 'running', total: comparable.length });
    let completed = 0;
    for (const [index, group] of comparable.entries()) {
        parentPort.postMessage({ current: `P${group.pid} · ${group.profile.language}` });
        const groupDir = path.join(dir, `group-${index}`);
        const result = problems.get(group.pid);
        try {
            for (const record of group.records) {
                const target = path.join(groupDir, record.id);
                await fs.mkdir(target, { recursive: true });
                await fs.writeFile(path.join(target, `Main.${record.profile.extension}`), record.code);
            }
            const report = await runJPlag(groupDir, group.profile.language, threshold, timeout);
            const byId = new Map(group.records.map((record) => [record.id, record]));
            const info = (record) => ({ id: record.id, uid: record.uid, lang: record.lang });
            for (const pair of report.pairs) {
                const left = byId.get(pair.left);
                const right = byId.get(pair.right);
                if (left && right && left.uid !== right.uid) {
                    result.pairs.push({ left: info(left), right: info(right), similarity: Number(pair.similarity.toFixed(2)) });
                }
            }
        } catch (error) {
            const message = error.code === 'ENOENT'
                ? USE_BUNDLED_JAVA ? '缺少内置 Java 运行时，请重新安装完整插件。' : '未找到系统 Java，请安装 Java 21 或更高版本并加入 PATH。'
                : error.killed ? `查重超过 ${timeout} 秒，请调整 SIM_TIMEOUT_SECONDS。`
                    : `JPlag 执行失败：${String(error.message).slice(0, 1000)}`;
            result.errors.push(`${group.profile.language}：${message}`);
        } finally {
            await fs.rm(groupDir, { recursive: true, force: true });
        }
        parentPort.postMessage({ completed: ++completed });
    }
    const results = [...problems.values()].sort((a, b) => Number(a.pid) - Number(b.pid));
    for (const result of results) result.pairs.sort((a, b) => b.similarity - a.similarity);
    parentPort.postMessage({ state: 'done', current: '', results });
}
run().catch((error) => parentPort.postMessage({ state: 'failed', error: `无法执行查重：${error.message}` }));
