/**
 * 包工头的 `/foreman` 入口。
 *
 * 宿主没有给插件留「斜杠命令」表，但 `ctx.skills.register()` 是公开的运行时接口：
 * 注册进去的 skill 会出现在 `/` 菜单里，用户敲 `/foreman …` 时宿主把这段正文和用户
 * 那句话一起注入，模型照着做。于是「斜杠直接派单」不用另造机制，也不用常驻系统提示词。
 *
 * @module dsh-agent-foreman/skill
 */

/** skill 名：宿主只接受小写字母、数字与连字符。 */
export const SKILL_NAME = 'foreman';

/**
 * skill 的 `source` 标签。
 *
 * 宿主的运行时 skill 记录要求 `source` 是非空字符串（用来标明来源），缺了它会在
 * **加载**时才报 `loaded skill "foreman" source must be a string`——注册阶段不报，很容易漏。
 */
export const SKILL_SOURCE = 'dsh-agent-foreman';

/** 中文正文：用户 `/foreman …` 之后要遵守的步骤。 */
const ZH = [
    '# 包工头派单',
    '',
    '用户已经用 `/foreman` 点了派单，不要反问、不要先解释流程，直接走完下面四步。',
    '',
    '1. **看名册**：调用 `foreman_roster`。名册为空或全关，就让用户去「设置 → 包工头」加人，然后结束。',
    '2. **拆单**：`/foreman` 后面的话按分号或换行切成若干张工单，一段一张。每张补齐：背景、要改的文件（全路径）、什么算完成。原话里缺文件路径就自己从上下文找，找不到就在工单里写明「需要先定位」。',
    '3. **派单**：一次 `foreman_dispatch`，`goal` 写明这一轮的总目标。**默认省略 `contractor`**——省略时按实时负载挑人（跳过正忙的、取最空闲的，跨会话可见），多张单会自然摊到不同的人身上。只有"这单必须由某个特定的人做"时才写名字；把每张单都写成「力工」会绕过负载分配，其余承包商闲置、活全串行排队。两人不要改同一处；有先后的写 `dependsOn`。',
    '4. **验收**：拿回看板后逐单 `foreman_review`。不合格写清缺什么再打回；返工额度用完就如实报失败。',
    '',
    '最后给用户一段汇报：一句结论、每单状态（谁做的、过没过）、需要他决定的事。不要复述产物全文，细节写路径。',
].join('\n');

/** 英文正文。 */
const EN = [
    '# Foreman dispatch',
    '',
    'The user invoked `/foreman`, so dispatch — do not ask what they mean or explain the process first. Four steps:',
    '',
    '1. **Roster**: call `foreman_roster`. If nobody is enabled, send the user to Settings → 包工头 and stop.',
    '2. **Split**: turn everything after `/foreman` into orders, one per semicolon or line. Each order needs background, exact file paths, and what counts as done. If the paths are missing, derive them from context or say "locate first" inside the order.',
    '3. **Dispatch**: one `foreman_dispatch` call with the round goal. **Omit `contractor` by default** — it then picks by live load (busy contractors are skipped, the least loaded one wins, cross-session), so several orders spread across people naturally. Name someone only when that specific contractor must do the work; writing 「力工」 on every order bypasses load balancing and serializes the work. Never aim two people at the same file; use `dependsOn` for sequential work.',
    '4. **Review**: review every order with `foreman_review`. Say exactly what is missing before sending it back; report the failure when the rework budget is gone.',
    '',
    'Then report: one-line verdict, per-order status (who, pass/fail), and the decisions the user owes you. No full deliverables, paths instead.',
].join('\n');

/** 目录里显示的一行说明。 */
export const SKILL_DESCRIPTION = '用包工头派单：把任务拆成工单交给名册里的承包商各自干，父智能体最后逐单验收。输入 /foreman 加任务即可。';

/**
 * 取 skill 正文。
 *
 * @param lang - `'zh'` 或其它（走英文）。
 * @returns 正文。
 */
export function foremanSkillContent(lang) {
    return lang === 'en' ? EN : ZH;
}

/**
 * 猜语言：拿不到 locale 就当中文。
 *
 * @param ctx - cordis 上下文。
 * @returns `'zh'` 或 `'en'`。
 */
export function languageOf(ctx) {
    try {
        const active = ctx?.locale?.getLocale?.()?.active;
        if (typeof active === 'string' && active.toLowerCase().startsWith('en'))
            return 'en';
    }
    catch {
        // 取不到就当中文。
    }
    return 'zh';
}
