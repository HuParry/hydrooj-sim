'use strict';
// Shared by the Hydro addon and the standalone server. No Hydro dependencies.
const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const AdmZip = require('./vendor/adm-zip/adm-zip.js');
const execFileAsync = promisify(execFile);
const JPLAG_JAR = path.join(__dirname, 'jplag-6.2.0-jar-with-dependencies.jar');
const USE_BUNDLED_JAVA = process.platform === 'linux' && process.arch === 'x64';
const JPLAG_JAVA = USE_BUNDLED_JAVA ? path.join(__dirname, '..', 'runtime/linux-x64/bin/java') : 'java';

const LANGUAGE_PROFILES = [
    { language: 'emf-model', extension: 'xmi', names: /^(?:emf[ -]?model|emf models?)\b/ },
    { language: 'scxml', extension: 'scxml', names: /^scxml\b/ },
    { language: 'llvmir', extension: 'll', names: /^(?:llvm(?:[ -]?ir)?|ll)\b/ },
    { language: 'typescript', extension: 'ts', names: /^(?:typescript|ts)\b/ },
    { language: 'javascript', extension: 'js', names: /^(?:javascript|js|nodejs|node\.js|ecmascript)\b/ },
    { language: 'csharp', extension: 'cs', names: /^(?:c#|csharp|cs|dotnet)\b/ },
    { language: 'cpp', extension: 'cpp', names: /^(?:c\+\+|g\+\+)(?:$|[^a-z])|^(?:cpp|cxx|cc)\b/ },
    { language: 'c', extension: 'c', names: /^c(?:$|[\s.(0-9])/ },
    { language: 'python3', extension: 'py', names: /^(?:python|pypy|py)(?:\b|\d)/ },
    { language: 'java', extension: 'java', names: /^java(?:$|[\s.(0-9])/ },
    { language: 'kotlin', extension: 'kt', names: /^(?:kotlin|kt)\b/ },
    { language: 'scala', extension: 'scala', names: /^scala\b/ },
    { language: 'scheme', extension: 'scm', names: /^(?:scheme|scm)\b/ },
    { language: 'go', extension: 'go', names: /^(?:go|golang)\b/ },
    { language: 'rust', extension: 'rs', names: /^(?:rust|rs)\b/ },
    { language: 'swift', extension: 'swift', names: /^swift\b/ },
    { language: 'rlang', extension: 'R', names: /^(?:rlang|r)(?:$|[\s.(0-9])/ },
    { language: 'emf', extension: 'ecore', names: /^(?:emf|ecore)\b/ },
    { language: 'multi', extension: 'txt', names: /^(?:multi|multilang|multi-language)\b/ },
];
const EXTENSION_LANGUAGES = {
    c: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', cs: 'csharp', ecore: 'emf',
    go: 'go', java: 'java', js: 'javascript', kt: 'kotlin', ll: 'llvmir',
    py: 'python3', r: 'rlang', rs: 'rust', sc: 'scala', scala: 'scala', scm: 'scheme',
    scxml: 'scxml', ss: 'scheme',
    swift: 'swift', ts: 'typescript', xmi: 'emf-model',
};
function getLanguageProfile(lang, languages = {}) {
    const language = String(lang || '');
    const config = languages[language];
    const names = [language.split('.')[0], language, config?.display, config?.highlight, config?.monaco]
        .filter(Boolean).map((name) => String(name).toLowerCase().trim());
    // JPlag's Python parser targets Python 3; Python 2 submissions use text comparison.
    if (names.some((name) => /(?:^|[._ -])(?:python|pypy|py)[._ -]*2(?:$|\b)/.test(name))) {
        return { language: 'text', family: `other:${language}`, extension: 'txt' };
    }
    const codeExtension = path.extname(config?.code_file || '').slice(1).toLowerCase();
    const profile = LANGUAGE_PROFILES.find((entry) => names.some((name) => entry.names.test(name)))
        || LANGUAGE_PROFILES.find((entry) => entry.language === EXTENSION_LANGUAGES[codeExtension]);
    if (profile)
        return { language: profile.language, family: profile.language, extension: profile.extension };
    // Keep unrelated Hydro language IDs apart when JPlag has no matching parser.
    return { language: 'text', family: `other:${language}`, extension: 'txt' };
}
async function runJPlag(rootDir, language, threshold, timeoutSeconds) {
    // JPlag writes its default report to the working directory. Each group has a fresh directory.
    const reportPath = path.join(rootDir, 'results.jplag');
    const args = [
        '-jar', JPLAG_JAR,
        '-M', 'RUN', '-l', language,
        '-n', '-1', '--cluster-skip', '.',
    ];
    try {
        await execFileAsync(JPLAG_JAVA, args, {
            cwd: rootDir,
            timeout: timeoutSeconds * 1000,
            maxBuffer: 64 * 1024 * 1024,
            encoding: 'utf8',
            windowsHide: true,
        });
    }
    catch (error) {
        const output = `${error.stderr || ''}\n${error.stdout || ''}`;
        if (!USE_BUNDLED_JAVA && /UnsupportedClassVersionError/.test(output)) {
            throw new Error('系统 Java 版本过低，请安装 Java 21 或更高版本，并确保 PATH 中的 java 指向该版本。');
        }
        if (/Not enough valid submissions/i.test(output)) {
            return { pairs: [], insufficient: true };
        }
        throw error;
    }
    const zip = new AdmZip(reportPath);
    const topEntry = zip.getEntry('topComparisons.json');
    const mappingsEntry = zip.getEntry('submissionMappings.json');
    if (!topEntry || !mappingsEntry)
        throw new Error('JPlag 报告缺少比较结果或提交映射文件。');
    const topComparisons = JSON.parse(topEntry.getData().toString('utf8'));
    const mappings = JSON.parse(mappingsEntry.getData().toString('utf8'));
    return {
        pairs: topComparisons.map((comparison) => ({
            left: mappings.submissionIds[comparison.firstSubmission],
            right: mappings.submissionIds[comparison.secondSubmission],
            similarity: comparison.similarities?.AVG * 100,
        })).filter((pair) => pair.left && pair.right && pair.left !== pair.right
            && Number.isFinite(pair.similarity) && pair.similarity >= threshold),
        insufficient: false,
    };
}

module.exports = { getLanguageProfile, runJPlag, USE_BUNDLED_JAVA };
