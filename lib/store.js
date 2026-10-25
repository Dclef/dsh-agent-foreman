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
     * 好处是成员出现在团队区、并且能在自己会话里换模型；代价是依赖
     * `agentTeams` 服务，链路更长。默认关闭，走普通激活路径。
     */
    teamMode: false,
});

/** 名册规模上限。超过 24 个承包商同时在场没有意义，只会撞并发上限。 */
const MEMBER_LIMIT = 24;
/** 名字长度上限。 */
const NAME_LIMIT = 40;
/** 单个承包商提示词长度上限。 */
const PROMPT_LIMIT = 4000;

/** 单个承包商同时干活的工单数上限。 */
const PARALLEL_LIMIT = 8;
/** 台账保留条数上限，超出后重写为最近的这一批。 */
const LEDGER_LIMIT = 400;

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
    if (/[\u0000-\u001f]/.test(name))
        throw new ForemanError('承包商名字不能包含控制字符', 'INVALID_NAME');

    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if ((provider === '') !== (model === ''))
        throw new ForemanError(`承包商「${name}」的 provider 与 model 必须同时给出，或同时留空表示继承父会话`, 'INVALID_ROUTE');

    const reasoningEffort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '';
    // 每个承包商可以带一段自己的提示词：写给"这个人"的常驻说明（岗位、手艺、禁忌）。
    // 设置页用眼睛图标打开编辑，派单时原样塞进它的工单提示词里；旧名册的 role/specialty/note
    // 会在第一次保存时并进来，避免用户升级后丢配置。
    const promptParts = [];
    for (const key of ['prompt', 'specialty', 'note']) {
        const value = typeof raw[key] === 'string' ? raw[key].trim() : '';
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

    return { id, name, prompt, enabled: raw.enabled !== false, provider, model, reasoningEffort, maxParallel };
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
