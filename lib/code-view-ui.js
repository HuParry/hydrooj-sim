// Shared browser renderer for the Hydro addon and the standalone website.
(() => {
    'use strict';
    const kinds = new Set(['comment', 'keyword', 'string', 'number', 'function', 'type',
        'operator', 'punctuation', 'variable', 'property', 'tag']);

    function render(content, data) {
        const fragment = document.createDocumentFragment();
        const view = document.createElement('div');
        view.className = 'sim-code-view';
        for (const row of data.rows) {
            const line = document.createElement('div');
            line.className = 'sim-code-row';
            for (const side of ['left', 'right']) {
                const cell = document.createElement('div');
                cell.className = 'sim-code-side';
                const number = document.createElement('span');
                number.className = 'sim-code-number';
                number.textContent = row[side + 'Number'] == null ? '' : String(row[side + 'Number']);
                const code = document.createElement('code');
                code.className = 'sim-code-text';
                for (const part of row[side]) {
                    const token = document.createElement('span');
                    if (kinds.has(part.kind)) token.className = 'sim-token-' + part.kind;
                    token.textContent = part.text;
                    code.appendChild(token);
                }
                cell.append(number, code);
                line.appendChild(cell);
            }
            view.appendChild(line);
        }
        fragment.appendChild(view);
        content.replaceChildren(fragment);
        content.scrollTop = 0;
    }

    function renderTitle(target, label, submission) {
        const userLink = document.createElement('a');
        userLink.href = submission.userUrl;
        userLink.textContent = `UID ${submission.uid}`;
        const recordLink = document.createElement('a');
        recordLink.href = submission.recordUrl;
        recordLink.textContent = submission.rid || submission.id;
        target.replaceChildren(document.createTextNode(`${label} · `), userLink,
            document.createTextNode(` · ${submission.lang} · `), recordLink);
    }
    window.SimCodeView = Object.freeze({ render, renderTitle });
})();
