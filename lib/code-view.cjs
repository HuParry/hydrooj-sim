'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

// Both deployment modes use this worker. Code is tokenized without executing it.
function buildCodeView(left, right) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: { simCodeView: true, left, right },
            resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        let received = false;
        const timer = setTimeout(() => {
            reject(new Error('代码高亮超时，请稍后重试。'));
            void worker.terminate();
        }, 15000);
        worker.once('message', (data) => {
            received = true;
            if (data.error) reject(new Error(data.error));
            else resolve(data);
        });
        worker.once('error', reject);
        worker.once('exit', () => {
            clearTimeout(timer);
            if (!received) reject(new Error('无法生成代码高亮，请稍后重试。'));
        });
    });
}

if (!isMainThread && workerData?.simCodeView) {
    try {
        const Prism = require('./vendor/prism.cjs');
        const { getLanguageProfile } = require('./engine.cjs');
        const aliases = {
            cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', 'g++': 'cpp',
            py: 'python', pypy: 'python', python2: 'python', python3: 'python',
            rlang: 'r', llvmir: 'llvm', ll: 'llvm', emf: 'markup', 'emf-model': 'markup',
            scxml: 'markup', cs: 'csharp', kt: 'kotlin', rs: 'rust', scm: 'scheme',
        };
        const kinds = {
            comment: 'comment', prolog: 'comment', doctype: 'comment', cdata: 'comment',
            keyword: 'keyword', atrule: 'keyword', important: 'keyword',
            string: 'string', char: 'string', regex: 'string', 'template-string': 'string',
            number: 'number', boolean: 'number', constant: 'number',
            function: 'function', 'function-variable': 'function', macro: 'function',
            'class-name': 'type', builtin: 'type', namespace: 'type',
            operator: 'operator', punctuation: 'punctuation', variable: 'variable',
            property: 'property', 'attr-name': 'property', 'attr-value': 'string',
            tag: 'tag', selector: 'tag', symbol: 'number',
        };

        function highlight(input) {
            const code = input.code.replace(/\r\n?/g, '\n');
            const config = { highlight: input.highlight, monaco: input.monaco, code_file: input.codeFile };
            const profile = getLanguageProfile(input.lang, { [input.lang]: config });
            const candidates = [input.highlight, input.monaco, profile.language === 'text' ? '' : profile.language,
                input.lang, input.lang.split('.')[0], input.codeFile?.split('.').pop(), input.lang.split('.').pop()];
            const language = candidates.filter(Boolean).map((name) => String(name).toLowerCase().trim())
                .map((name) => aliases[name] || name).find((name) => Object.hasOwn(Prism.languages, name)
                    && typeof Prism.languages[name] === 'object'
                    && Object.keys(Prism.languages[name]).length > 0) || 'clike';
            let tokens;
            try {
                tokens = Prism.tokenize(code, Prism.languages[language]);
            } catch {
                tokens = Prism.tokenize(code, Prism.languages.clike);
            }
            const lines = [[]];
            function append(value, kind = '') {
                if (typeof value === 'string') {
                    const chunks = value.split('\n');
                    for (let i = 0; i < chunks.length; i++) {
                        if (i) lines.push([]);
                        if (chunks[i]) lines[lines.length - 1].push({ text: chunks[i], kind });
                    }
                } else if (Array.isArray(value)) {
                    for (const token of value) append(token, kind);
                } else if (value) append(value.content, kinds[value.type] || kind);
            }
            append(tokens);
            if (!code || code.endsWith('\n')) lines.pop();
            return lines;
        }

        const left = highlight(workerData.left);
        const right = highlight(workerData.right);
        const rows = [];
        // Keep each submission's original line order. No diff alignment or inserted lines.
        for (let index = 0; index < Math.max(left.length, right.length); index++) {
            rows.push({ leftNumber: index < left.length ? index + 1 : null,
                rightNumber: index < right.length ? index + 1 : null,
                left: left[index] || [], right: right[index] || [] });
        }
        parentPort.postMessage({ rows });
    } catch (error) {
        parentPort.postMessage({ error: error.message });
    }
}

module.exports = { buildCodeView };
