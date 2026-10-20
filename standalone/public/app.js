'use strict';
const $ = (id) => document.getElementById(id);
let polling = 0;
let diffRequest = 0;
let currentJob = '';
let resultOjUrl = '';
let resultData;

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function link(label, route) {
    const base = resultOjUrl;
    if (!base) return element('span', label);
    const a = element('a', label);
    a.href = base + route;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
}

function recordLabel(record) {
    const box = element('div');
    box.append(link(`UID ${record.uid}`, `/user/${record.uid}`));
    const id = link(record.id, `/record/${record.id}`);
    id.className = 'record';
    box.append(id);
    return box;
}

function showError(text) {
    $('error').textContent = text;
    $('error').hidden = !text;
}

async function json(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '请求失败。');
    return data;
}

function renderResults(results) {
    const fragment = document.createDocumentFragment();
    if (!results.length) fragment.append(element('p', '没有查重结果。', 'empty'));
    for (const result of results) {
        const section = element('section', undefined, 'problem');
        const title = element('h3');
        title.append(link(`P${result.pid}`, `/p/${result.pid}`));
        section.append(title, element('p', `纳入比较：${result.recordCount} 份提交`, 'muted'));
        for (const error of result.errors) section.append(element('p', error, 'error'));
        if (result.pairs.length) {
            const details = element('details');
            const summary = element('summary');
            const uids = [...new Set(result.pairs.flatMap((pair) => [pair.left.uid, pair.right.uid]))].sort((a, b) => Number(a) - Number(b));
            summary.append(document.createTextNode('关联用户：'));
            uids.forEach((uid, index) => {
                if (index) summary.append(document.createTextNode('、'));
                summary.append(link(`UID ${uid}`, `/user/${uid}`));
            });
            const min = result.pairs.reduce((value, pair) => Math.min(value, pair.similarity), Infinity);
            const max = result.pairs.reduce((value, pair) => Math.max(value, pair.similarity), -Infinity);
            summary.append(document.createTextNode(`；相似度：${(min / 100).toFixed(2)} ~ ${(max / 100).toFixed(2)} · ${result.pairs.length} 对`));
            const table = element('table');
            const head = element('thead');
            const headings = element('tr');
            for (const label of ['提交 A', '提交 B', '相似度', '代码对比']) headings.append(element('th', label));
            head.append(headings);
            const body = element('tbody');
            for (const pair of result.pairs) {
                const row = element('tr');
                for (const record of [pair.left, pair.right]) {
                    const cell = element('td');
                    cell.append(recordLabel(record));
                    row.append(cell);
                }
                row.append(element('td', `${pair.similarity}%`));
                const cell = element('td');
                const button = element('button', 'Diff', 'secondary diff-trigger');
                button.type = 'button';
                button.addEventListener('click', () => openDiff(pair));
                cell.append(button);
                row.append(cell);
                body.append(row);
            }
            table.append(head, body);
            const scroll = element('div', undefined, 'table-scroll');
            scroll.append(table);
            details.append(summary, scroll);
            section.append(details);
        } else section.append(element('p', '没有查重结果。', 'empty'));
        fragment.append(section);
    }
    $('results').replaceChildren(fragment);
    $('results-section').hidden = false;
}

async function watch(id) {
    const request = ++polling;
    currentJob = id;
    resultOjUrl = '';
    if ($('diff-dialog').open) $('diff-dialog').close();
    diffRequest++;
    resultData = undefined;
    $('results-section').hidden = true;
    $('progress-section').hidden = false;
    $('progress').removeAttribute('value');
    $('percent').textContent = '';
    $('start').disabled = true;
    $('delete-job').hidden = true;
    showError('');
    while (request === polling) {
        try {
            const job = await json(`/api/jobs/${id}`);
            if (request !== polling) return;
            resultOjUrl = job.ojUrl;
            $('percent').textContent = job.percent === null ? '' : `${job.percent}%`;
            if (job.percent === null) $('progress').removeAttribute('value');
            else $('progress').value = job.percent;
            const labels = { uploading: '正在上传…', queued: '任务已排队，等待执行…', preparing: '正在读取压缩包并整理代码…', running: `已完成 ${job.completed} / ${job.total} 个语言组${job.current ? ` · ${job.current}` : ''}`, done: '查重完成。', failed: '查重失败。' };
            $('status').textContent = labels[job.state] || '正在处理…';
            if (job.state === 'done') {
                resultData = job.results;
                renderResults(resultData);
                $('start').disabled = false;
                $('delete-job').hidden = false;
                return;
            }
            if (job.state === 'failed') {
                showError(job.error);
                $('start').disabled = false;
                $('delete-job').hidden = false;
                return;
            }
        } catch (error) {
            if (request !== polling) return;
            showError(error.message);
            $('status').textContent = '获取任务失败，可刷新页面重试。';
            $('start').disabled = false;
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
}

function upload(file, threshold, token) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/jobs?threshold=${encodeURIComponent(threshold)}`);
        xhr.setRequestHeader('Content-Type', 'application/zip');
        xhr.responseType = 'json';
        xhr.timeout = 120000;
        xhr.upload.onprogress = (event) => {
            if (token !== polling) return;
            if (!event.lengthComputable) return;
            const percent = Math.floor(event.loaded * 100 / event.total);
            $('progress').value = percent;
            $('percent').textContent = `${percent}%`;
            $('status').textContent = percent === 100 ? '上传完成，正在创建任务…' : '正在上传比赛代码…';
        };
        xhr.onload = () => xhr.status === 202 ? resolve(xhr.response) : reject(new Error(xhr.response?.error || `上传失败（${xhr.status}）。`));
        xhr.onerror = () => reject(new Error('上传失败，请检查网络后重试。'));
        xhr.ontimeout = () => reject(new Error('上传超时，请重试。'));
        xhr.send(file);
    });
}

$('upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = $('archive').files[0];
    if (!file) return;
    if (file.size > 128 * 1024 * 1024) return showError('ZIP 大小不能超过 128 MiB。');
    const token = ++polling;
    showError('');
    $('start').disabled = true;
    $('delete-job').hidden = true;
    $('results-section').hidden = true;
    $('progress-section').hidden = false;
    $('progress').value = 0;
    $('percent').textContent = '0%';
    $('status').textContent = '正在上传比赛代码…';
    try {
        const data = await upload(file, $('threshold').value, token);
        if (token !== polling) return;
        const fragment = `#job=${data.id}`;
        if (location.hash === fragment) void watch(data.id);
        else location.hash = fragment;
    } catch (error) {
        if (token !== polling) return;
        showError(error.message);
        $('status').textContent = '上传失败。';
        $('start').disabled = false;
    }
});

async function openDiff(pair) {
    const request = ++diffRequest;
    const dialog = $('diff-dialog');
    const content = $('diff-content');
    content.replaceChildren(element('p', '正在加载代码…', 'message'));
    $('diff-left').textContent = '提交 A';
    $('diff-right').textContent = '提交 B';
    if (!dialog.open) dialog.showModal();
    try {
        const data = await json(`/api/jobs/${currentJob}/diff?left=${pair.left.id}&right=${pair.right.id}`);
        if (request !== diffRequest || !dialog.open) return;
        SimCodeView.renderTitle($('diff-left'), '提交 A', data.left);
        SimCodeView.renderTitle($('diff-right'), '提交 B', data.right);
        SimCodeView.render(content, data);
    } catch (error) {
        if (request === diffRequest && dialog.open) content.replaceChildren(element('p', error.message, 'message error'));
    }
}
$('close-diff').addEventListener('click', () => $('diff-dialog').close());
$('diff-dialog').addEventListener('close', () => { diffRequest++; });
$('download').addEventListener('click', () => {
    if (!resultData) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(resultData, null, 2)], { type: 'application/json' }));
    const a = element('a');
    a.href = url;
    a.download = `hydrooj-sim-${currentJob}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('delete-job').addEventListener('click', async () => {
    if (!confirm('删除本次查重结果和临时代码？此操作无法恢复。')) return;
    const id = currentJob;
    const request = polling;
    $('delete-job').disabled = true;
    try {
        const response = await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (request !== polling) return;
        if (!response.ok) throw new Error(data.error);
        location.hash = '';
        resultData = undefined;
        currentJob = '';
        $('results').replaceChildren();
        $('results-section').hidden = true;
        $('progress-section').hidden = true;
        showError('');
    } catch (error) { if (request === polling) showError(error.message); }
    finally { $('delete-job').disabled = false; }
});
function loadHash() {
    const match = /^#job=([a-f\d]{48})$/.exec(location.hash);
    if (match) void watch(match[1]);
    else {
        polling++;
        diffRequest++;
        currentJob = '';
        resultOjUrl = '';
        resultData = undefined;
        if ($('diff-dialog').open) $('diff-dialog').close();
        $('start').disabled = false;
        $('results').replaceChildren();
        $('results-section').hidden = true;
        $('progress-section').hidden = true;
        showError('');
    }
}
window.addEventListener('hashchange', loadHash);
loadHash();
