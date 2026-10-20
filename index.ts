import { buildCodeView } from './lib/code-view.cjs';
import { getLanguageProfile as resolveLanguageProfile, runJPlag, USE_BUNDLED_JAVA } from './lib/engine.cjs';
import os from 'os';
import path from 'path';
import {
    ContestModel, Context, db, fs, Handler, NotFoundError, ObjectId, PERM, PermissionError, PRIV, ProblemModel, RecordModel,
    RecordNotFoundError, Schema, STATUS, SettingModel, SystemModel, Types, param, post,
} from 'hydrooj';

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const JOB_HEARTBEAT_MS = 10 * 1000;
const JOB_STALE_MS = 5 * 60 * 1000;

interface SimJobDoc {
    _id: ObjectId;
    domainId: string;
    tid: ObjectId;
    threshold: number;
    state: 'preparing' | 'running' | 'saving' | 'done' | 'failed';
    completed: number;
    total: number;
    current?: string;
    error?: string;
    createdAt: Date;
    updatedAt: Date;
    expireAt: Date;
}

interface SimStoredProblem extends Omit<ProblemResult, 'pairs'> {
    _id: ObjectId;
    jobId: ObjectId;
    expireAt: Date;
}

interface SimStoredPair extends SimilarityPair {
    _id: ObjectId;
    jobId: ObjectId;
    problemDocId: number;
    expireAt: Date;
}

declare module 'hydrooj' {
    interface Collections {
        'sim.job': SimJobDoc;
        'sim.problem': SimStoredProblem;
        'sim.pair': SimStoredPair;
    }
}

const jobColl = db.collection('sim.job');
const problemColl = db.collection('sim.problem');
const pairColl = db.collection('sim.pair');

interface SimilarityPair {
    left: string;
    right: string;
    similarity?: number;
    displaySimilarity?: number;
    leftRecord?: { _id: ObjectId, uid: number };
    rightRecord?: { _id: ObjectId, uid: number };
}

interface ProblemResult {
    problem: any;
    recordCount: number;
    pairs: SimilarityPair[];
    errors: string[];
    userUids: number[];
    similarityMin?: string;
    similarityMax?: string;
}

function getLanguageProfile(lang: string) {
    return resolveLanguageProfile(lang, SettingModel.langs);
}

function checkContestAccess(handler: Handler, tdoc: any) {
    if (!handler.user.own(tdoc) && !handler.user.hasPerm(PERM.PERM_EDIT_CONTEST)
        && !handler.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
        throw new PermissionError(PERM.PERM_EDIT_CONTEST);
    }
}

function renderResults(handler: Handler, body: Record<string, any>) {
    handler.response.template = 'sim.html';
    handler.response.body = { form: { threshold: 50 }, ...body };
}

async function runSimilarityJob(job: SimJobDoc) {
    let tempDir: string;
    const heartbeat = setInterval(() => {
        void jobColl.updateOne({ _id: job._id, state: { $in: ['preparing', 'running', 'saving'] } }, {
            $set: { updatedAt: new Date() },
        }).catch((error) => console.error('SIM job heartbeat failed:', error));
    }, JOB_HEARTBEAT_MS);
    heartbeat.unref();
    try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydro-sim-'));
        const tdoc = await ContestModel.get(job.domainId, job.tid);
        const groups = new Map<string, {
            problem: any; language: string; dir: string;
            candidates: { _id: ObjectId, uid: number }[];
        }>();
        const problems = await ProblemModel.getList(job.domainId, tdoc.pids, true, true, ProblemModel.PROJECTION_CONTEST_LIST);
        const byDocId = new Map(tdoc.pids.map((pid) => [pid, problems[pid]]));
        const records = RecordModel.getMulti(job.domainId, {
            contest: job.tid,
            pid: { $in: tdoc.pids },
            score: { $gt: 0 },
            code: { $exists: true, $ne: '' },
            judgeAt: { $ne: null },
            status: { $nin: [STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED, STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING] },
        }).project({ _id: 1, uid: 1, pid: 1, lang: 1, code: 1 });
        for await (const record of records) {
            if (!record.code?.trim()) continue;
            const profile = getLanguageProfile(record.lang);
            const problem = byDocId.get(record.pid);
            if (!problem) continue;
            const key = `${record.pid}\0${profile.family}`;
            let group = groups.get(key);
            if (!group) {
                group = {
                    problem, language: profile.language,
                    dir: path.join(tempDir, String(record.pid), encodeURIComponent(profile.family)),
                    candidates: [],
                };
                await fs.ensureDir(group.dir);
                groups.set(key, group);
            }
            const id = record._id.toHexString();
            const submissionDir = path.join(group.dir, id);
            await fs.ensureDir(submissionDir);
            await fs.writeFile(path.join(submissionDir, `Main.${profile.extension}`), record.code, 'utf8');
            group.candidates.push({ _id: record._id, uid: record.uid });
        }

        const problemResults = new Map<number, ProblemResult>();
        for (const problem of byDocId.values()) {
            if (!problem) continue;
            problemResults.set(problem.docId, {
                problem: { docId: problem.docId, pid: problem.pid, title: problem.title },
                recordCount: 0, pairs: [], errors: [], userUids: [],
            });
        }
        const total = [...groups.values()].filter((group) => group.candidates.length >= 2).length;
        let completed = 0;
        await jobColl.updateOne({ _id: job._id }, {
            $set: { state: 'running', total, updatedAt: new Date() },
        });
        for (const group of groups.values()) {
            const result = problemResults.get(group.problem.docId);
            if (!result) continue;
            result.recordCount += group.candidates.length;
            if (group.candidates.length < 2) continue;
            await jobColl.updateOne({ _id: job._id }, {
                $set: { current: `${group.problem.pid || group.problem.docId} · ${group.language}`, updatedAt: new Date() },
            });
            const timeoutSeconds = Math.max(10, Number(SystemModel.get('jplag.timeoutSeconds')) || 300);
            try {
                const jplagResult = await runJPlag(group.dir, group.language, job.threshold, timeoutSeconds);
                if (!jplagResult.insufficient) {
                    const byId = new Map(group.candidates.map((record) => [record._id.toHexString(), record]));
                    for (const pair of jplagResult.pairs) {
                        const leftRecord = byId.get(pair.left);
                        const rightRecord = byId.get(pair.right);
                        if (leftRecord && rightRecord && leftRecord.uid !== rightRecord.uid) {
                            result.pairs.push({ ...pair, leftRecord, rightRecord });
                        }
                    }
                }
            } catch (error) {
                result.errors.push(error.code === 'ENOENT'
                    ? USE_BUNDLED_JAVA
                        ? '插件内缺少 Java 运行时，请重新安装完整插件包。'
                        : '未找到系统 Java，请安装 Java 21 或更高版本，并将 java 加入 Hydro 服务进程的 PATH。'
                    : error.killed || error.code === 'ETIMEDOUT'
                        ? `JPlag 比较超过 ${timeoutSeconds} 秒后超时。可在系统设置中提高 jplag.timeoutSeconds。`
                        : `JPlag 执行失败${error.code ? `（退出码 ${error.code}）` : error.signal ? `（${error.signal}）` : ''}：${String(error.stderr || error.stdout || error.message || error).trim().slice(0, 1500)}`);
            }
            completed++;
            await jobColl.updateOne({ _id: job._id }, {
                $set: { completed, updatedAt: new Date() },
            });
        }
        await jobColl.updateOne({ _id: job._id }, {
            $set: { state: 'saving', current: '正在整理查重结果', updatedAt: new Date() },
        });
        for (const result of problemResults.values()) {
            result.pairs.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
            for (const pair of result.pairs) pair.displaySimilarity = Number(pair.similarity!.toFixed(2));
            result.userUids = [...new Set(result.pairs.flatMap((pair) => [pair.leftRecord!.uid, pair.rightRecord!.uid]))]
                .sort((a, b) => a - b);
            if (result.pairs.length) {
                const scores = result.pairs.map((pair) => pair.similarity || 0);
                result.similarityMin = (scores.reduce((min, score) => Math.min(min, score), Infinity) / 100).toFixed(2);
                result.similarityMax = (scores.reduce((max, score) => Math.max(max, score), -Infinity) / 100).toFixed(2);
            }
            const { pairs, ...metadata } = result;
            await problemColl.insertOne({ _id: new ObjectId(), jobId: job._id, expireAt: job.expireAt, ...metadata });
            for (let i = 0; i < pairs.length; i += 500) {
                await pairColl.insertMany(pairs.slice(i, i + 500).map((pair) => ({
                    _id: new ObjectId(), jobId: job._id, problemDocId: result.problem.docId,
                    expireAt: job.expireAt, ...pair,
                })));
            }
        }
        await jobColl.updateOne({ _id: job._id }, {
            $set: { state: 'done', completed: total, current: '', updatedAt: new Date() },
        });
    } catch (error) {
        await jobColl.updateOne({ _id: job._id }, {
            $set: {
                state: 'failed', current: '', updatedAt: new Date(),
                error: `查重失败：${String(error.stderr || error.message || error).trim().slice(0, 1500)}`,
            },
        });
    } finally {
        clearInterval(heartbeat);
        if (tempDir) await fs.remove(tempDir).catch((error) => console.error('SIM job cleanup failed:', error));
    }
}

async function loadJob(handler: Handler, jobId: ObjectId) {
    const job = await jobColl.findOne({ _id: jobId, domainId: handler.domain._id });
    if (!job) throw new NotFoundError();
    const contest = await ContestModel.get(job.domainId, job.tid);
    checkContestAccess(handler, contest);
    if (['preparing', 'running', 'saving'].includes(job.state) && Date.now() - job.updatedAt.getTime() > JOB_STALE_MS) {
        const failed = await jobColl.findOneAndUpdate({ _id: jobId, state: job.state, updatedAt: job.updatedAt }, {
            $set: { state: 'failed', current: '', updatedAt: new Date(), error: '查重任务已中断，请重新开始。' },
        }, { returnDocument: 'after' });
        if (failed) return { job: failed, contest };
        const current = await jobColl.findOne({ _id: jobId, domainId: handler.domain._id });
        if (!current) throw new NotFoundError();
        return { job: current, contest };
    }
    return { job, contest };
}

class SimHandler extends Handler {
    async get() {
        renderResults(this, {});
    }

    @post('tid', Types.ObjectId)
    @post('threshold', Types.Int, (value) => +value >= 0 && +value <= 100)
    async post(domainId: string, tid: ObjectId, threshold: number) {
        const tdoc = await ContestModel.get(domainId, tid);
        checkContestAccess(this, tdoc);
        const now = new Date();
        const job: SimJobDoc = {
            _id: new ObjectId(), domainId, tid, threshold,
            state: 'preparing', completed: 0, total: 0,
            createdAt: now, updatedAt: now, expireAt: new Date(now.getTime() + JOB_TTL_MS),
        };
        await jobColl.insertOne(job);
        void runSimilarityJob(job).catch((error) => console.error('SIM job failed:', error));
        this.response.redirect = this.url('sim_job', { jobId: job._id });
    }
}

class SimJobHandler extends Handler {
    @param('jobId', Types.ObjectId)
    async get(domainId: string, jobId: ObjectId) {
        const { job, contest } = await loadJob(this, jobId);
        this.response.addHeader('Cache-Control', 'private, no-store');
        if (job.state !== 'done') {
            renderResults(this, {
                form: { tid: job.tid, threshold: job.threshold }, contest, job,
                jobPercent: job.total ? Math.min(99, Math.floor(job.completed * 100 / job.total)) : null,
                error: job.state === 'failed' ? job.error : undefined,
            });
            return;
        }
        const problems = await problemColl.find({ jobId }).toArray();
        const pairs = await pairColl.find({ jobId }).toArray();
        const byProblem = new Map<number, SimilarityPair[]>();
        for (const pair of pairs) {
            if (!byProblem.has(pair.problemDocId)) byProblem.set(pair.problemDocId, []);
            byProblem.get(pair.problemDocId).push(pair);
        }
        const problemOrder = new Map(contest.pids.map((pid, i) => [pid, i]));
        const results = problems.sort((a, b) => (problemOrder.get(a.problem.docId) ?? Infinity)
            - (problemOrder.get(b.problem.docId) ?? Infinity)).map((problem) => ({
            ...problem,
            pairs: (byProblem.get(problem.problem.docId) || []).sort((a, b) => (b.similarity || 0) - (a.similarity || 0)),
        }));
        renderResults(this, { form: { tid: job.tid, threshold: job.threshold }, contest, results });
    }
}

class SimProgressHandler extends Handler {
    @param('jobId', Types.ObjectId)
    async get(domainId: string, jobId: ObjectId) {
        const { job } = await loadJob(this, jobId);
        this.response.addHeader('Cache-Control', 'private, no-store');
        this.response.body = {
            state: job.state, completed: job.completed, total: job.total,
            percent: job.state === 'done' ? 100 : job.total ? Math.min(99, Math.floor(job.completed * 100 / job.total)) : null,
            current: job.current || '', error: job.error || '',
        };
    }
}

class SimDiffHandler extends Handler {
    @param('tid', Types.ObjectId)
    @param('left', Types.ObjectId)
    @param('right', Types.ObjectId)
    async get(domainId: string, tid: ObjectId, leftId: ObjectId, rightId: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid);
        checkContestAccess(this, tdoc);
        const [left, right] = await Promise.all([
            RecordModel.get(domainId, leftId), RecordModel.get(domainId, rightId),
        ]);
        if (!left || !right
            || left.contest?.toString() !== tid.toString() || right.contest?.toString() !== tid.toString()
            || left.pid !== right.pid || !tdoc.pids.includes(left.pid) || left.uid === right.uid
            || getLanguageProfile(left.lang).family !== getLanguageProfile(right.lang).family
            || !left.code?.trim() || !right.code?.trim()
            || !left.judgeAt || !right.judgeAt
            || [left.status, right.status].some((status) => [
                STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED, STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING,
            ].includes(status))) {
            throw new RecordNotFoundError(leftId);
        }
        this.response.addHeader('Cache-Control', 'private, no-store');
        const input = (record: typeof left) => ({
            code: record.code, lang: record.lang,
            highlight: SettingModel.langs[record.lang]?.highlight,
            monaco: SettingModel.langs[record.lang]?.monaco,
            codeFile: SettingModel.langs[record.lang]?.code_file,
        });
        const { rows } = await buildCodeView(input(left), input(right));
        this.response.body = {
            left: {
                rid: left._id.toString(), uid: left.uid, lang: left.lang,
                userUrl: this.url('user_detail', { uid: left.uid }),
                recordUrl: this.url('record_detail', { rid: left._id }),
            },
            right: {
                rid: right._id.toString(), uid: right.uid, lang: right.lang,
                userUrl: this.url('user_detail', { uid: right.uid }),
                recordUrl: this.url('record_detail', { rid: right._id }),
            },
            rows,
        };
    }
}

class SimCodeAssetsHandler extends Handler {
    @param('file', Types.String)
    async get(domainId: string, file: string) {
        const assets = { 'code-view-ui.js': 'application/javascript', 'code-view.css': 'text/css' };
        if (!Object.hasOwn(assets, file)) throw new NotFoundError();
        this.response.addHeader('Cache-Control', 'no-cache');
        this.response.type = assets[file];
        this.response.body = await fs.readFile(path.join(__dirname, 'lib', file), 'utf8');
    }
}

export const name = 'sim';

export async function apply(ctx: Context) {
    ctx.setting.SystemSetting(Schema.object({
        jplag: Schema.object({
            timeoutSeconds: Schema.number().default(300).min(10).max(1800).step(1).description('JPlag 单次运行超时秒数。'),
        }),
    }));
    ctx.Route('sim', '/sim', SimHandler, PERM.PERM_VIEW);
    ctx.Route('sim_job', '/sim/job/:jobId', SimJobHandler, PERM.PERM_VIEW);
    ctx.Route('sim_progress', '/sim/job/:jobId/progress', SimProgressHandler, PERM.PERM_VIEW);
    ctx.Route('sim_code_assets', '/sim/assets/:file', SimCodeAssetsHandler, PERM.PERM_VIEW);
    ctx.Route('sim_diff', '/sim/diff/:tid/:left/:right', SimDiffHandler, PERM.PERM_VIEW);
    await Promise.all([
        db.ensureIndexes(jobColl, { name: 'expire', key: { expireAt: 1 }, expireAfterSeconds: 0 }),
        db.ensureIndexes(problemColl,
            { name: 'expire', key: { expireAt: 1 }, expireAfterSeconds: 0 },
            { name: 'job', key: { jobId: 1 } }),
        db.ensureIndexes(pairColl,
            { name: 'expire', key: { expireAt: 1 }, expireAfterSeconds: 0 },
            { name: 'job', key: { jobId: 1 } }),
    ]);
}
