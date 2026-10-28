/**
 * 包工头 · 名册与台账的持久化。
 *
 * 两块数据，两种寿命：
 *
 * - **名册（roster.json）** 是配置：承包商叫什么、跑哪个 provider/模型、开启与否。
 *   它跨会话存在，由设置页编辑，派单时读取。
 * - **台账（runs.jsonl）** 是运行记录：每次派单追加一行（不存正文，只存结构与
 *   字数/耗时），给设置页的历史面板用。看板正文只活在内存里，一轮任务结束就
 *   随结果回到父智能体手里——它才是真正的交付通道。
 *
 * 这里不做任何 IO 缓存：名册文件是人手改也说得过去的纯 JSON，每次读都重新解析
 * 代价可以忽略，换来"改完立刻生效"。
 *
 * @module dsh-agent-foreman/store
 */
import fs from 'node:fs';
import path from 'node:path';

/** 派单的默认策略；设置页可覆盖，工具调用时也可按单覆盖。 */
export const DEFAULT_POLICY = Object.freeze({
    /** 同时在场的承包商数量上限。深了会撞 subagents 的全局并发上限。 */
    concurrency: 4,
    /** 单张工单的墙钟预算（秒）。到点未交付即判超时并释放。 */
    timeoutSeconds: 900,
    /** 打回后允许返工的次数。0 表示只审不改。 */
    maxRework: 1,
    /** 派出去的子智能体自身还能不能再派（递归预算）。 */
    maxDepth: 1,
    /** 启动子智能体用的 subagents provider 名（宿主原生是 `spawn`）。 */
    provider: 'spawn',
    /**
     * 团队模式：把承包商做成宿主的「智能体团队」成员来派单。
     *
     * 开启后成员具备三项能力：
     * 1. **原生团队标签页**——成员出现在宿主「智能体团队」区；
     * 2. **常驻跨轮记忆**——成员会话持久，同一人跨单记得上下文；
     * 3. **模型可选**——通过拦截注入在创建时锁定名册模型（`agentOptions`）。
     *
     * 产物回收靠成员自报 `foreman_report`，不依赖读成员会话。读不到会话时自动
     * 退回普通模式，不阻断派单。
     */
    teamMode: true,
});

/** 名册规模上限。超过 24 个承包商同时在场没有意义，只会撞并发上限。 */
const MEMBER_LIMIT = 24;
/** 名字长度上限。 */
const NAME_LIMIT = 40;
/** 岗位长度上限。和名字同档：岗位是给人看的分组标签，不是一句话。 */
const ROLE_LIMIT = 40;
/** 控制字符：名字与岗位都必须是单行可读文本。 */
const CONTROL_CHARS = /[\u0000-\u001f]/;
/** 单个承包商提示词长度上限。 */
const PROMPT_LIMIT = 4000;

/** 单个承包商同时干活的工单数上限。 */
const PARALLEL_LIMIT = 8;
/** 台账保留条数上限，超出后重写为最近的这一批。 */
const LEDGER_LIMIT = 400;

/** 快照文件名只允许这些字符：runId 直接进路径，必须先过这道闸。 */
const SNAPSHOT_ID = /^[A-Za-z0-9._-]+$/;
/** 快照序列化深度上限：看板数据只有两层，深过这个必然是挂上来的宿主对象。 */
const SNAPSHOT_DEPTH = 8;
/** 快照读取的默认条数（引擎按 id 找时会要得更多）。 */
const SNAPSHOT_LIMIT = 50;
/**
 * 不写进快照的字段名：它们是宿主对象或运行时句柄，既不可序列化，也会把整张
 * 上下文图（含父会话）拖进磁盘。
 */
const SNAPSHOT_DROP = new Set([
    'parent', 'ctx', 'context', 'agent', 'agentContext', 'session', 'service', 'services',
    'signal', 'controller', 'activation', 'dispose', 'logger', 'abortController',
]);
/**
 * 键名像"凭证容器"的字段一律不落盘。
 *
 * 用后缀锚定而不是子串匹配：`inputTokens` / `maxTokens` 这类计量字段要保留，
 * `apiKey` / `access_token` / `secret` 这类才跳过。
 */
const SECRET_KEY = /(?:^|[-_])(?:api[-_]?key|apikey|key|secret|password|passwd|credential|credentials|authorization|cookie|token)$/i;
/** 值里像密钥的片段做一次替换：常见前缀 + 足够长的随机串。 */
const SECRET_VALUE = /\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g;

/** 插件自己的错误类型：带一个稳定的 code，路由层据此回 4xx。 */
export class ForemanError extends Error {
    /**
     * @param message - 面向人/模型的可读说明。
     * @param code - 稳定标识（`DUPLICATE_NAME`、`UNKNOWN_MEMBER` …）。
     */
    constructor(message, code = 'INVALID') {
        super(message);
        this.name = 'ForemanError';
        this.code = code;
    }
}

/**
 * 解析数据目录。
 *
 * 和桌面端其它自建插件一致：显式环境变量优先，其次 `LOCALAPPDATA`，最后退回
 * 宿主给的 baseDir。写在固定位置的好处是换 profile 后名册还在，坏处是同一台
 * 机器的所有 profile 共用一份名册——对"承包商队伍"来说这正是想要的。
 *
 * @param baseDir - 宿主提供的 baseDir（`ctx.get('baseDir')`），可能缺省。
 * @param env - 环境变量来源，测试可注入。
 * @returns 绝对路径。
 */
export function resolveDataDir(baseDir, env = process.env) {
    const explicit = env.DSH_AGENT_FOREMAN_DATA;
    if (typeof explicit === 'string' && explicit.trim() !== '')
        return explicit;
    const local = env.LOCALAPPDATA;
    if (typeof local === 'string' && local.trim() !== '')
        return path.join(local, 'dsh-agent-foreman');
    return path.join(baseDir ?? process.cwd(), '.data');
}

/** 把名字压成稳定 id：只留字母数字与连字符，全大写转小写。 */
function slugify(name) {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug === '' ? 'member' : slug;
}

/**
 * 校验并规范化一个承包商条目。
 *
 * 路由三态是这里的核心约定：`provider`/`model` 要么都有值（显式指定），要么都
 * 为空（继承父会话）。只给一半是配置错误——派单时无法推断，宁可现在就报。
 *
 * @param raw - 界面或工具传来的原始对象。
 * @param existing - 现有名册，用于查重。
 * @returns 规范化后的承包商。
 */
export function normalizeMember(raw, existing = []) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new ForemanError('承包商必须是一个对象', 'INVALID_MEMBER');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name === '')
        throw new ForemanError('承包商必须有名字', 'INVALID_NAME');
    if ([...name].length > NAME_LIMIT)
        throw new ForemanError(`承包商名字最多 ${NAME_LIMIT} 个字符`, 'INVALID_NAME');
    if (CONTROL_CHARS.test(name))
        throw new ForemanError('承包商名字不能包含控制字符', 'INVALID_NAME');

    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if ((provider === '') !== (model === ''))
        throw new ForemanError(`承包商「${name}」的 provider 与 model 必须同时给出，或同时留空表示继承父会话`, 'INVALID_ROUTE');

    const reasoningEffort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '';

    // 岗位（role）：派单时 `contractor` 除了写名字，也可以写岗位名，引擎会在该岗位
    // 的启用实例之间轮转。旧名册里的 `role` 曾是一段描述性文字（被并进提示词），
    // 所以这里只把"像岗位"的值当岗位——超长或带控制字符的一律按旧文本处理，
    // 折回提示词、岗位退回名字。硬报错会让老条目在升级后整条被丢掉，那不是兼容。
    const rawRole = typeof raw.role === 'string' ? raw.role.trim() : '';
    const roleLike = rawRole !== '' && [...rawRole].length <= ROLE_LIMIT && !CONTROL_CHARS.test(rawRole);
    const role = roleLike ? rawRole : name;

    // 每个承包商可以带一段自己的提示词：写给"这个人"的常驻说明（手艺、禁忌）。
    // 设置页用眼睛图标打开编辑，派单时原样塞进它的工单提示词里；旧名册的
    // specialty/note 会在第一次保存时并进来，避免用户升级后丢配置。role 不再并进
    // 提示词——它是可检索的分组，并进去会让"岗位"和"这个人怎么干活"混为一谈；
    // 唯一例外是上面那种旧描述性 role。
    const promptParts = [];
    const sources = { prompt: raw.prompt, specialty: raw.specialty, note: raw.note };
    if (!roleLike && rawRole !== '')
        sources.legacyRole = rawRole.replace(CONTROL_CHARS, ' ');
    for (const [key, rawValue] of Object.entries(sources)) {
        const value = typeof rawValue === 'string' ? rawValue.trim() : '';
        if (value !== '' && !promptParts.includes(value))
            promptParts.push(value);
    }
    const prompt = promptParts.join(String.fromCharCode(10));
    if ([...prompt].length > PROMPT_LIMIT)
        throw new ForemanError(`承包商的提示词最多 ${PROMPT_LIMIT} 个字符`, 'INVALID_PROMPT');

    // 并发：同一个承包商同时接几张单，默认 1（串行，不会自己跟自己抢文件）。
    const maxParallel = normalizeNumber(raw.maxParallel, 1, 1, PARALLEL_LIMIT);

    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : slugify(name);
    const duplicate = existing.find(other => other.id !== id && other.name.toLowerCase() === name.toLowerCase());
    if (duplicate !== undefined)
        throw new ForemanError(`已经有同名承包商「${name}」`, 'DUPLICATE_NAME');
    if (existing.length >= MEMBER_LIMIT && !existing.some(other => other.id === id))
        throw new ForemanError(`名册最多 ${MEMBER_LIMIT} 个承包商`, 'ROSTER_FULL');

    return { id, name, role, prompt, enabled: raw.enabled !== false, provider, model, reasoningEffort, maxParallel };
}

/**
 * 一个数值策略字段的规范化：非数或越界时回退默认值，避免面板手抖毁掉配置。
 * @param value - 候选值。
 * @param fallback - 默认值。
 * @param min - 下界（含）。
 * @param max - 上界（含）。
 */
function normalizeNumber(value, fallback, min, max) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * 校验并合并策略字段。
 * @param raw - 部分策略。
 * @param base - 当前策略，作为缺省来源。
 * @returns 完整策略。
 */
export function normalizePolicy(raw, base = DEFAULT_POLICY) {
    const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    const provider = typeof source.provider === 'string' && source.provider.trim() !== ''
        ? source.provider.trim()
        : base.provider;
    return {
        concurrency: normalizeNumber(source.concurrency, base.concurrency, 1, 8),
        timeoutSeconds: normalizeNumber(source.timeoutSeconds, base.timeoutSeconds, 10, 3600),
        maxRework: normalizeNumber(source.maxRework, base.maxRework, 0, 3),
        maxDepth: normalizeNumber(source.maxDepth, base.maxDepth, 0, 2),
        provider,
        teamMode: typeof source.teamMode === 'boolean' ? source.teamMode : base.teamMode === true,
    };
}

/** 空名册。 */
function emptyState() {
    return { version: 1, members: [], policy: { ...DEFAULT_POLICY } };
}

/**
 * 把一个 id 规范成能安全拼进文件名的形态。
 *
 * 派单 id 是模型/面板给的字符串，直接进路径就等于把 `<dataDir>/runs/` 的边界
 * 交给调用方——`../../roster.json` 这种值必须在这里被挡住。白名单只有
 * `[A-Za-z0-9._-]`，再排掉 `.` 与 `..`（它们本身也符合白名单，但指向目录）。
 *
 * @param value - 候选 id。
 * @returns 合法 id；不合法时为空串（调用方据此跳过或拒绝）。
 */
export function sanitizeRunId(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '' || text.length > 120)
        return '';
    if (text === '.' || text === '..')
        return '';
    return SNAPSHOT_ID.test(text) ? text : '';
}

/**
 * 深拷贝成"只含 JSON 可序列化字段"的普通对象。
 *
 * 快照要落盘，所以函数、Symbol、循环引用、宿主对象都必须在这里被剪掉；剪掉的
 * 对象字段直接不写，数组里的空洞补 null 以保住下标。字符串里的密钥片段做一次
 * 替换——快照是本机文件，但本机文件也会被复制、贴进 issue。
 *
 * @param value - 任意值。
 * @param depth - 当前深度（内部用）。
 * @param seen - 当前路径上的对象（用于发现循环引用，内部用）。
 * @returns 可 JSON 化的副本；该值不值得保存时返回 undefined。
 */
function toSerializable(value, depth = 0, seen = new Set()) {
    if (value === null)
        return null;
    const type = typeof value;
    if (type === 'string')
        return value.replace(SECRET_VALUE, '[redacted]');
    if (type === 'number')
        return Number.isFinite(value) ? value : null;
    if (type === 'boolean')
        return value;
    if (type === 'bigint')
        return String(value);
    if (type !== 'object')
        return undefined;
    if (seen.has(value) || depth >= SNAPSHOT_DEPTH)
        return undefined;
    if (value instanceof Date)
        return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
    if (value instanceof Error)
        return { name: String(value.name ?? 'Error'), message: String(value.message ?? '') };
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const list = [];
            for (const item of value) {
                const next = toSerializable(item, depth + 1, seen);
                list.push(next === undefined ? null : next);
            }
            return list;
        }
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            if (SNAPSHOT_DROP.has(key) || SECRET_KEY.test(key))
                continue;
            const next = toSerializable(item, depth + 1, seen);
            if (next !== undefined)
                output[key] = next;
        }
        return output;
    }
    finally {
        seen.delete(value);
    }
}

/** 快照的"新鲜度"时间戳：优先更新时间，其次结束时间，最后创建时间。 */
function snapshotStamp(snapshot) {
    for (const key of ['updatedAt', 'finishedAt', 'createdAt']) {
        const value = snapshot?.[key];
        if (typeof value === 'string' && value !== '')
            return value;
    }
    return '';
}

/**
 * 比较两份快照谁更新：先看 `updatedAt`/`finishedAt`/`createdAt`，再退化到
 * `savedAt`（写盘时刻），最后按文件名字典序兜底，保证结果稳定。
 * @returns 正数表示 left 更新。
 */
function compareSnapshots(left, right) {
    if (left.stamp !== right.stamp)
        return left.stamp > right.stamp ? 1 : -1;
    const leftSaved = typeof left.snapshot.savedAt === 'string' ? left.snapshot.savedAt : '';
    const rightSaved = typeof right.snapshot.savedAt === 'string' ? right.snapshot.savedAt : '';
    if (leftSaved !== rightSaved)
        return leftSaved > rightSaved ? 1 : -1;
    if (left.name !== right.name)
        return left.name > right.name ? 1 : -1;
    return 0;
}

/**
 * 把临时文件换成正式文件，Windows 上对短暂的占用做几次重试。
 *
 * POSIX 的 rename 会原子覆盖，Windows 上目标文件被杀毒/索引/另一个读者短暂占住
 * 时 `EPERM`/`EBUSY`/`EACCES` 是可能出现的，重试两三次通常会过去。这里用同步
 * 小睡而不是异步等待：写快照的调用点是同步的，异步会把"已经存好了"变成一种
 * 需要 await 的猜测。
 *
 * @param temp - 临时文件。
 * @param file - 目标文件。
 */
function renameWithRetry(temp, file, attempts = 4) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            fs.renameSync(temp, file);
            return;
        }
        catch (error) {
            lastError = error;
            const code = error?.code;
            if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')
                throw error;
            if (attempt < attempts - 1)
                sleepSync(5 * (attempt + 1));
        }
    }
    throw lastError;
}

/** 同步小睡：只有在已经被阻塞的同步路径上才用得上。 */
function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
    catch {
        // 极少数环境不支持 SharedArrayBuffer：那就直接重试，不睡。
    }
}

/**
 * 名册存储：一个 JSON 文件加一个 JSONL 台账。
 *
 * 写盘用同步 API：每次改动的数据量是几百字节，异步只会让"面板改了但工具读到
 * 旧值"这种竞态变得可能。
 */
export class ForemanStore {
    /** @param dataDir - 数据目录（见 {@link resolveDataDir}）。 */
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.rosterFile = path.join(dataDir, 'roster.json');
        this.ledgerFile = path.join(dataDir, 'runs.jsonl');
        /** 快照目录：`runs.jsonl` 之外的另一份，供重启后只读恢复。 */
        this.runsDir = path.join(dataDir, 'runs');
        this.state = this.#load();
    }

    /** 读盘；坏文件当作空名册，但不覆盖它（下次写入才会重建）。 */
    #load() {
        try {
            const text = fs.readFileSync(this.rosterFile, 'utf8');
            const parsed = JSON.parse(text);
            const members = Array.isArray(parsed?.members)
                ? parsed.members.flatMap((entry) => {
                    try {
                        return [normalizeMember(entry, [])];
                    }
                    catch {
                        // 单条坏数据不该让整份名册失效：跳过它，保住其它条目。
                        return [];
                    }
                })
                : [];
            return { version: 1, members, policy: normalizePolicy(parsed?.policy) };
        }
        catch {
            return emptyState();
        }
    }

    /** 落盘。名册是配置，写失败必须冒泡——静默丢弃改动比报错更坏。 */
    #persist() {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const temp = `${this.rosterFile}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
        fs.renameSync(temp, this.rosterFile);
    }

    /** 名册副本（防止调用方改到内部状态）。 */
    members() {
        return this.state.members.map(member => ({ ...member }));
    }

    /** 当前策略副本。 */
    policy() {
        return { ...this.state.policy };
    }

    /** 名册与策略的快照。 */
    snapshot() {
        return { members: this.members(), policy: this.policy() };
    }

    /**
     * 整体替换名册（设置页的保存语义）。
     * @param list - 承包商数组。
     * @returns 保存后的名册。
     */
    saveMembers(list) {
        if (!Array.isArray(list))
            throw new ForemanError('名册必须是数组', 'INVALID_ROSTER');
        const members = [];
        for (const raw of list) {
            const candidate = normalizeMember(raw, members);
            if (members.some(other => other.id === candidate.id))
                throw new ForemanError(`承包商 id 重复：「${candidate.id}」`, 'DUPLICATE_ID');
            members.push(candidate);
        }
        this.state.members = members;
        this.#persist();
        return this.members();
    }

    /**
     * 新增或更新一个承包商（按 id 或名字匹配）。
     * @param raw - 承包商条目。
     * @returns 规范化后的条目。
     */
    upsertMember(raw) {
        const list = this.members();
        const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
        const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
        const index = list.findIndex(other => (id !== '' && other.id === id)
            || (name !== '' && other.name.toLowerCase() === name.toLowerCase()));
        const others = index === -1 ? list : list.filter((_, i) => i !== index);
        const member = normalizeMember(raw, others);
        if (index === -1)
            list.push(member);
        else
            list[index] = member;
        this.saveMembers(list);
        return { ...member };
    }

    /**
     * 删除一个承包商。
     * @param key - id 或名字。
     * @returns 是否真的删掉了。
     */
    removeMember(key) {
        const wanted = typeof key === 'string' ? key.trim().toLowerCase() : '';
        const list = this.members();
        const next = list.filter(member => member.id.toLowerCase() !== wanted && member.name.toLowerCase() !== wanted);
        if (next.length === list.length)
            return false;
        this.saveMembers(next);
        return true;
    }

    /**
     * 合并策略字段。
     * @param patch - 部分策略。
     * @returns 保存后的策略。
     */
    savePolicy(patch) {
        this.state.policy = normalizePolicy(patch, this.state.policy);
        this.#persist();
        return this.policy();
    }

    /**
     * 追加一条运行记录。写失败只记日志不影响派单——台账是附加物，不是交付物。
     * @param record - 精简过的运行记录。
     * @returns 是否写入成功。
     */
    recordRun(record) {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            fs.appendFileSync(this.ledgerFile, `${JSON.stringify(record)}\n`, 'utf8');
            this.#trimLedger();
            return true;
        }
        catch {
            return false;
        }
    }

    /**
     * 把一份完整产物落盘。
     *
     * 看板里只放前若干千字（见 engine 的 ARTIFACT_LIMIT），被截掉的部分躺在这里，
     * 需要细节时按路径去读——这样"摘要短"和"有据可查"不再互相牵制。
     *
     * @param runId - 派单 id。
     * @param orderId - 工单 id。
     * @param text - 完整产物正文。
     * @returns 绝对路径；写失败时空串（产物落盘是附加物，不该让派单失败）。
     */
    writeArtifact(runId, orderId, text) {
        try {
            const dir = path.join(this.dataDir, 'artifacts');
            fs.mkdirSync(dir, { recursive: true });
            const safe = `${runId}-${orderId}`.replace(/[^\w.-]+/g, '_');
            const file = path.join(dir, `${safe}.md`);
            fs.writeFileSync(file, text, 'utf8');
            return file;
        }
        catch {
            return '';
        }
    }

    /**
     * 保存一轮运行的可序列化快照到 `<dataDir>/runs/<runId>.json`。
     *
     * 和台账是两份东西：`runs.jsonl` 仍然是设置页的历史（格式不动），快照则是
     * "插件重启后还能把这一轮看板找回来"的还原点，所以它要带上工单正文。
     *
     * 写盘走"临时文件 + rename"：进程在写到一半时被杀，读者看到的要么是旧文件、
     * 要么是新文件，不会是一截残缺的 JSON。写失败一律返回 false 不抛——快照是
     * 附加物，写不进去不该让派单本身失败。
     *
     * 落盘前会递归剪掉不可序列化的东西（函数、循环引用、`parent`/`ctx` 这类宿主
     * 对象），并跳过疑似密钥的字段与片段。`member.prompt` 属于本机数据目录里的
     * 配置文本，正常保留。
     *
     * @param run - 一轮运行记录。
     * @returns 是否写入成功。
     */
    saveRunSnapshot(run) {
        try {
            if (run === null || typeof run !== 'object')
                return false;
            // 没有工单数组的记录读回来也没用（看板渲染与恢复都依赖它），
            // 写盘前就拒掉，读写两侧保持同一套形状约束。
            if (!Array.isArray(run.orders))
                return false;
            const id = sanitizeRunId(run.id);
            if (id === '')
                return false;
            const plain = toSerializable(run);
            if (plain === undefined || typeof plain !== 'object' || Array.isArray(plain))
                return false;
            // 剪枝可能把 id 弄丢（比如它本来就不是字符串），这里补回规范化后的值。
            plain.id = id;
            // 快照自带时间戳：引擎恢复时要靠它判断"同一 runId 的哪份更新"。
            plain.savedAt = new Date().toISOString();
            fs.mkdirSync(this.runsDir, { recursive: true });
            const file = path.join(this.runsDir, `${id}.json`);
            const temp = path.join(this.runsDir, `.${id}.${process.pid}.${Date.now()}.tmp`);
            try {
                fs.writeFileSync(temp, `${JSON.stringify(plain, null, 2)}\n`, 'utf8');
                renameWithRetry(temp, file);
            }
            catch {
                try {
                    fs.rmSync(temp, { force: true });
                }
                catch {
                    // 清理临时文件失败无关紧要：下次 save 会覆盖同名 tmp。
                }
                return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }

    /**
     * 读出快照目录里最近的若干份运行。
     *
     * 单条损坏只跳过它，不影响其它条——一份被截断的 JSON 不该让整块看板消失。
     * 同一 runId 出现多次（旧版直接覆盖写、手工拷贝留下副本等）时保留较新的那份，
     * 判定依据是 `updatedAt` / `finishedAt`，退化到 `createdAt` / `savedAt`。
     *
     * @param limit - 条数上限。
     * @returns 快照数组，新在前。
     */
    loadRunSnapshots(limit = SNAPSHOT_LIMIT) {
        const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : SNAPSHOT_LIMIT;
        let names;
        try {
            names = fs.readdirSync(this.runsDir);
        }
        catch {
            return [];
        }
        /** runId → 最新的一份快照。 */
        const newest = new Map();
        for (const name of names) {
            if (typeof name !== 'string' || !name.endsWith('.json'))
                continue;
            const id = sanitizeRunId(name.slice(0, -'.json'.length));
            if (id === '')
                continue;
            let snapshot;
            try {
                const parsed = JSON.parse(fs.readFileSync(path.join(this.runsDir, name), 'utf8'));
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                    continue;
                if (!Array.isArray(parsed.orders))
                    continue;
                snapshot = parsed;
            }
            catch {
                // 损坏 / 半截文件：跳过这一条。
                continue;
            }
            // 身份以文件里的 `id` 为准，认不出时才退回文件名：手工拷贝留下的
            // `R-1.backup.json` 与 `R-1.json` 内容里是同一个 runId，属于同一轮。
            const inner = sanitizeRunId(snapshot.id);
            const key = inner !== '' ? inner : id;
            const entry = { name, stamp: snapshotStamp(snapshot), snapshot: { ...snapshot, id: key } };
            const previous = newest.get(key);
            if (previous === undefined || compareSnapshots(entry, previous) >= 0)
                newest.set(key, entry);
        }
        return [...newest.values()]
            .sort((left, right) => compareSnapshots(right, left))
            .slice(0, max)
            .map(entry => entry.snapshot);
    }

    /** 台账超长时重写为最近 {LEDGER_LIMIT} 条，避免无限膨胀。 */    #trimLedger() {
        try {
            const stat = fs.statSync(this.ledgerFile);
            if (stat.size < 512 * 1024)
                return;
            const lines = fs.readFileSync(this.ledgerFile, 'utf8').split('\n').filter(line => line.trim() !== '');
            if (lines.length <= LEDGER_LIMIT)
                return;
            fs.writeFileSync(this.ledgerFile, `${lines.slice(-LEDGER_LIMIT).join('\n')}\n`, 'utf8');
        }
        catch {
            // 台账裁剪失败可以接受：下一轮还会再试。
        }
    }

    /**
     * 读最近若干条运行记录（新在前）。
     * @param limit - 条数上限。
     * @returns 运行记录数组；文件缺失或损坏时为空数组。
     */
    recentRuns(limit = 20) {
        try {
            const text = fs.readFileSync(this.ledgerFile, 'utf8');
            return text
                .split('\n')
                .filter(line => line.trim() !== '')
                .slice(-limit)
                .reverse()
                .flatMap((line) => {
                    try {
                        return [JSON.parse(line)];
                    }
                    catch {
                        return [];
                    }
                });
        }
        catch {
            return [];
        }
    }
}
