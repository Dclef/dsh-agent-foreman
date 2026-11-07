/**
 * engines.dsh 兼容性回归。
 *
 * 宿主（dsh-app-boot）用 `semver.satisfies(version, range, { includePrerelease: true })`
 * 判定插件能否加载；而 npm / pnpm / 其它工具用的是默认语义。一个健康的范围必须在
 * **两种语义下**都放行当前 DSH 版本，否则升级宿主后插件会在部分入口被拒。
 *
 * DSH 0.2.2-rc.1 是预发布版：默认 semver 规则里，预发布版本只匹配带同一
 * `[major, minor, patch]` 预发布比较符的范围。原范围 `>=0.2.1-rc.2 <0.3.0-0`
 * 在 includePrerelease 下通过、在默认语义下却把 0.2.2-rc.1 判为 false。
 * 这里不引入新的运行时依赖：能解析到 semver 就复核，解析不到就锁住范围字符串。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const RANGE = manifest.engines.dsh;

/** 用宿主自带的 semver 实现（如有）复核；取不到时返回 undefined。 */
function optionalSemver() {
    try {
        return createRequire(import.meta.url)('semver');
    }
    catch {
        return undefined;
    }
}

test('engines.dsh 同时覆盖 0.2.1 与 0.2.2 预发布线，并挡住 0.3.0', () => {
    // 纯字符串兜底（不引入运行时依赖）：两段比较符必须都在，且上界不松动。
    assert.match(RANGE, />=0\.2\.1-rc\.2/, '仍要兼容最初的 0.2.1-rc.2 宿主');
    assert.match(RANGE, />=0\.2\.2-0/, '范围必须包含 0.2.2 预发布起点，否则默认 semver 会拒绝 0.2.2-rc.1');
    assert.match(RANGE, /<0\.3\.0-0/, '上界仍须挡住 0.3.0 预发布与正式版');
    assert.doesNotMatch(RANGE, /<0\.4\.0|<1\.0\.0/, '不该悄悄放宽到 0.3/0.4');
});

test('engines.dsh 在宿主 includePrerelease:true 语义下也正确（能解析到 semver 时复核）', () => {
    const semver = optionalSemver();
    if (semver === undefined)
        return;
    for (const version of ['0.2.1-rc.2', '0.2.2-rc.1', '0.2.2-rc.9', '0.2.2'])
        assert.equal(semver.satisfies(version, RANGE, { includePrerelease: true }), true, `${version} 应在宿主语义下兼容`);
    for (const version of ['0.3.0-rc.1', '0.3.0'])
        assert.equal(semver.satisfies(version, RANGE, { includePrerelease: true }), false, `${version} 不该被放行`);
});

test('package.json 与 package-lock.json 的版本、引擎范围一致', () => {
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[''].version, manifest.version);
    assert.equal(lock.packages[''].engines.dsh, manifest.engines.dsh);
});
