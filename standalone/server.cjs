#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 3000);
const TIMEOUT = Number(process.env.SIM_TIMEOUT_SECONDS ?? 300);
let OJ_URL;
const MAX_UPLOAD = 128 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const MAX_JOBS = 10;
const jobs = new Map();
let busy = false;
let root;
let closing = false;
let diffBusy = false;

function runDiff(dir, left, right) {
    if (diffBusy) {
        const error = new Error('正在生成其他代码差异，请稍后重试。');
        error.status = 429;
        throw error;
    }
    diffBusy = true;
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(path.join(__dirname, 'diff.cjs'), {
                workerData: { dir, left, right },
                resourceLimits: { maxOldGenerationSizeMb: 256 },
            });
        } catch (error) {
            diffBusy = false;
            reject(error);
            return;
        }
        const timer = setTimeout(() => {
            reject(new Error('代码差异生成超时，请下载原始提交后比较。'));
            void worker.terminate();
        }, 15000);
        let received = false;
        worker.once('message', (data) => {
            received = true;
            if (data.error) reject(new Error(data.error));
            else resolve(data.rows);
        });
        worker.once('error', reject);
        worker.once('exit', () => {
            clearTimeout(timer);
            diffBusy = false;
            if (!received) reject(new Error('无法生成代码差异，请稍后重试。'));
        });
    });
}

function reply(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

async function saveUpload(req, filename) {
    if (Number(req.headers['content-length']) > MAX_UPLOAD) {
        const error = new Error('ZIP 大小不能超过 128 MiB。');
        error.status = 413;
        throw error;
    }
    let size = 0;
    const limit = new Transform({
        transform(chunk, encoding, callback) {
            size += chunk.length;
            if (size > MAX_UPLOAD) {
                const error = new Error('ZIP 大小不能超过 128 MiB。');
                error.status = 413;
                callback(error);
            } else callback(null, chunk);
        },
    });
    await pipeline(req, limit, createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
}

function publicJob(job) {
    return {
        id: job.id, ojUrl: job.ojUrl, state: job.state, completed: job.completed, total: job.total,
        current: job.current || '', error: job.error || '',
        percent: job.state === 'done' ? 100 : job.total ? Math.min(99, Math.floor(job.completed * 100 / job.total)) : null,
        results: job.state === 'done' ? job.results : undefined,
    };
}

function startWorker(job) {
    busy = true;
    job.state = 'preparing';
    let worker;
    try {
        worker = new Worker(path.join(__dirname, 'worker.cjs'), {
            workerData: { dir: job.dir, threshold: job.threshold, timeout: TIMEOUT },
            resourceLimits: { maxOldGenerationSizeMb: 512 },
        });
    } catch (error) {
        busy = false;
        Object.assign(job, { state: 'failed', error: `无法启动查重进程：${error.message}`, finishedAt: Date.now() });
        const next = [...jobs.values()].find((item) => item.state === 'queued');
        if (next && !closing) queueMicrotask(() => startWorker(next));
        return;
    }
    let finished = false;
    worker.on('message', (message) => {
        if (message.state === 'done' || message.state === 'failed') finished = true;
        Object.assign(job, message);
    });
    worker.on('error', (error) => {
        job.state = 'failed';
        job.error = `查重任务失败：${error.message}`;
    });
    worker.on('exit', () => {
        if (!finished && job.state !== 'failed') {
            job.state = 'failed';
            job.error = '查重进程意外退出，请重试。';
        }
        job.finishedAt = Date.now();
        busy = false;
        if (!closing) {
            const next = [...jobs.values()].find((item) => item.state === 'queued');
            if (next) startWorker(next);
        }
    });
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
        if (closing) return reply(res, 503, { error: '服务正在关闭。' });
        // Browser uploads must originate from this host. No cross-origin API access.
        if (['POST', 'DELETE'].includes(req.method) && req.headers.origin) {
            const origin = new URL(req.headers.origin);
            if (origin.host !== req.headers.host) return reply(res, 403, { error: '不允许跨站上传。' });
        }
        const url = new URL(req.url, 'http://localhost');
        const assets = {
            '/': ['index.html', 'text/html; charset=utf-8'],
            '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
            '/style.css': ['style.css', 'text/css; charset=utf-8'],
        };
        if (req.method === 'GET' && assets[url.pathname]) {
            const [file, type] = assets[url.pathname];
            const data = await fs.readFile(path.join(__dirname, 'public', file));
            res.writeHead(200, { 'Content-Type': type });
            return res.end(data);
        }
        if (req.method === 'POST' && url.pathname === '/api/jobs') {
            if (req.headers['content-type']?.split(';')[0] !== 'application/zip') {
                return reply(res, 415, { error: '请上传 ZIP 文件。' });
            }
            const raw = url.searchParams.get('threshold');
            const threshold = raw === null || !raw.trim() ? NaN : Number(raw);
            if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
                return reply(res, 400, { error: '相似度阈值必须为 0–100 之间的数字。' });
            }
            if (jobs.size >= MAX_JOBS) return reply(res, 429, { error: '当前任务已满，请删除已完成的历史任务后重试。' });
            // Reserve before awaiting body to bound simultaneous uploads and queue size.
            const id = randomBytes(24).toString('hex');
            const job = { id, ojUrl: OJ_URL, state: 'uploading', threshold, completed: 0, total: 0, dir: path.join(root, id), createdAt: Date.now() };
            jobs.set(id, job);
            try {
                await fs.mkdir(job.dir);
                await saveUpload(req, path.join(job.dir, 'upload.zip'));
                if (closing) throw new Error('服务正在关闭。');
                job.state = 'queued';
                if (!busy) startWorker(job);
                return reply(res, 202, { id });
            } catch (error) {
                jobs.delete(id);
                await fs.rm(job.dir, { recursive: true, force: true });
                throw error;
            }
        }
        const match = /^\/api\/jobs\/([a-f\d]{48})(\/diff)?$/.exec(url.pathname);
        if (req.method === 'DELETE' && match && !match[2]) {
            const job = jobs.get(match[1]);
            if (!job) return reply(res, 404, { error: '任务不存在或已过期。' });
            if (!job.finishedAt) return reply(res, 409, { error: '任务仍在运行，请稍后重试。' });
            if (diffBusy) return reply(res, 409, { error: '正在生成代码差异，请稍后重试。' });
            jobs.delete(job.id);
            await fs.rm(job.dir, { recursive: true, force: true });
            return reply(res, 200, { deleted: true });
        }
        if (req.method === 'GET' && match) {
            const job = jobs.get(match[1]);
            if (!job) return reply(res, 404, { error: '任务不存在或已过期。' });
            if (!match[2]) return reply(res, 200, publicJob(job));
            const left = url.searchParams.get('left');
            const right = url.searchParams.get('right');
            const pair = job.results?.flatMap((result) => result.pairs).find((item) => item.left.id === left && item.right.id === right);
            if (job.state !== 'done' || !pair) return reply(res, 404, { error: '比较结果不存在。' });
            const rows = await runDiff(job.dir, left, right);
            return reply(res, 200, { left: pair.left, right: pair.right, rows });
        }
        return reply(res, 404, { error: '页面不存在。' });
    } catch (error) {
        if (!res.headersSent && !res.destroyed) reply(res, error.status || 400, { error: error.message || '请求失败。' });
    }
});
server.requestTimeout = 120000;

async function main() {
    if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
        console.log('用法：SIM_OJ_URL=https://oj.example.com hydrooj-sim\n可选环境变量：HOST、PORT、SIM_TIMEOUT_SECONDS。');
        return;
    }
    if (process.argv.length > 2) throw new Error('不支持启动参数；请通过 SIM_OJ_URL、HOST、PORT、SIM_TIMEOUT_SECONDS 环境变量配置。');
    try {
        const parsed = new URL((process.env.SIM_OJ_URL || '').trim());
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
        OJ_URL = parsed.href.replace(/\/+$/, '');
    } catch {
        throw new Error('请设置 SIM_OJ_URL 为有效的 HTTP 或 HTTPS OJ 地址，例如 https://oj.example.com/d/example；不要包含账号、查询参数或锚点。');
    }
    if (!HOST.trim() || /\s|[/?#]/.test(HOST)) throw new Error('HOST 必须为有效的监听地址，例如 0.0.0.0。');
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT 必须为 1–65535 的整数。');
    if (!Number.isInteger(TIMEOUT) || TIMEOUT < 10 || TIMEOUT > 1800) throw new Error('SIM_TIMEOUT_SECONDS 必须为 10–1800 的整数。');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'hydro-sim-web-'));
    server.on('error', async (error) => {
        console.error(error.message);
        await fs.rm(root, { recursive: true, force: true });
        process.exitCode = 1;
    });
    const timer = setInterval(() => {
        for (const [id, job] of jobs) {
            if (!diffBusy && job.finishedAt && Date.now() - job.finishedAt >= TTL) {
                jobs.delete(id);
                void fs.rm(job.dir, { recursive: true, force: true }).catch(console.error);
            }
        }
    }, 60000).unref();
    server.listen(PORT, HOST, () => console.log(`hydrooj-sim 独立模式：http://${HOST}:${PORT}\n临时目录：${root}`));
    async function shutdown() {
        if (closing) return;
        closing = true;
        clearInterval(timer);
        server.close();
        console.log('正在等待当前查重完成后关闭…');
        const wait = setInterval(async () => {
            if (busy || diffBusy || [...jobs.values()].some((job) => job.state === 'uploading')) return;
            clearInterval(wait);
            await fs.rm(root, { recursive: true, force: true });
        }, 300);
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
