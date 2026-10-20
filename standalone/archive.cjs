const path = require('node:path');
const AdmZip = require('../lib/vendor/adm-zip/adm-zip.js');
const { getLanguageProfile } = require('../lib/engine.cjs');

const MAX_FILES = 10000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

// Hydro ContestCodeHandler: U<uid>_P<pid>_R<rid>[_S<status>@<score>].<lang>
// Only generated IDs become paths on disk; archive paths are never extracted.
function readArchive(buffer) {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (entries.length > MAX_FILES) throw new Error(`压缩包最多允许 ${MAX_FILES} 个文件条目。`);
    const records = new Map();
    let recognized = 0;
    let totalBytes = 0;
    for (const entry of entries) {
        if (entry.isDirectory || entry.entryName.includes('__MACOSX/')) continue;
        const name = path.posix.basename(entry.entryName.replace(/\\/g, '/'));
        const match = /^U(\d+)_P(\d+)_R([a-f\d]{24})(?:_S(\d+)@(-?\d+(?:\.\d+)?))?\.(.+)$/i.exec(name);
        if (!match) continue;
        recognized++;
        const [, uid, pid, rid, status, score, language] = match;
        if (score !== undefined && Number(score) <= 0) continue;
        if (status !== undefined && [0, 20, 21, 22].includes(Number(status))) continue;
        if (!entry.header.size) continue;
        if (entry.header.size > MAX_FILE_BYTES) throw new Error(`单份代码不能超过 2 MiB：${name}`);
        totalBytes += entry.header.size;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error('代码解压后总大小不能超过 256 MiB。');
        const data = entry.getData();
        if (data.length !== entry.header.size) throw new Error(`文件大小校验失败：${name}`);
        const code = new TextDecoder('utf-8', { fatal: true }).decode(data);
        if (!code.trim()) continue;
        if (records.has(rid.toLowerCase())) throw new Error(`压缩包包含重复提交 ID：${rid}`);
        records.set(rid.toLowerCase(), {
            id: rid.toLowerCase(), uid, pid, lang: language, code,
            profile: getLanguageProfile(language, { [language]: { code_file: language } }),
        });
    }
    if (!recognized) throw new Error('未找到 Hydro 比赛导出代码，请上传从比赛管理页面导出的 ZIP。');
    return [...records.values()];
}

module.exports = { readArchive };
