# 安装与升级 · v0.4.1

发布日期：2026-11-07（Asia/Shanghai）。GitHub Release 与 npm 同步发布。

## 兼容与重要说明

- Node.js：22.19+（22.x）或 24+；宿主声明范围：
  DSH `>=0.2.1-rc.2 <0.3.0-0 || >=0.2.2-0 <0.3.0-0`。
  第二段显式覆盖 `0.2.2` 预发布线，使范围在标准 semver 与宿主 `includePrerelease: true`
  两种判定下都通过（DSH 0.2.2-rc.1 因此不会被入口拒绝）。
- **原生团队内部兼容桥已验证 DSH 0.2.1-rc.5，并在 DSH 0.2.2-rc.1 重新核验**：
  `roster.spawn` / `startActivation` 契约未变，宿主仍不透传 `agentOptions`。
  声明的安装范围不等于每个版本都经过原生团队契约验收；宿主内部结构改变时明确失败，
  不创建替代子会话或偷换父模型。
- 每个承包商可选 provider、模型与思考等级。团队模式同一成员串行，不同成员可以并行。
- 原生编队空闲卡片可能回显父模型的回退标签；实际调用以工地的请求配置记录为准。

## GitHub 安装 / 升级

使用 DSH 自带的插件命令：

```bash
dsh plugin add Dclef/dsh-agent-foreman
```

安装后**彻底退出并重新启动 DSH**，再打开「设置 → 包工头」。
若系统找不到 dsh，请从当前 DSH 安装提供的终端运行，而不是修改全局 Node 环境。

## npm 精确版本安装

在**当前 DSH profile 目录**执行，勿在无关项目或全局目录安装：

```bash
npm install --save-exact dsh-agent-foreman@0.4.1
```

profile 使用 pnpm 管理时沿用 pnpm，不混用锁文件：

```bash
pnpm add --save-exact dsh-agent-foreman@0.4.1
```

首次手动安装还需在 profile 的 package.json 中保留/加入：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-agent-foreman"]
    }
  }
}
```

将此配置合并到已有对象与 bundles 数组，**不要覆盖其它插件**。随后重启 DSH。

## 固定版本离线包

GitHub Release 附带 dsh-agent-foreman-0.4.1.tgz，与 npm 发布内容完全相同。
假设下载到 E:/downloads，可在 profile 目录安装：

```bash
npm install --save-exact E:/downloads/dsh-agent-foreman-0.4.1.tgz
# 或沿用该 profile 的 pnpm
pnpm add E:/downloads/dsh-agent-foreman-0.4.1.tgz
```

Release 同时提供 SHA256SUMS.txt；下载后校验再安装，并重启 DSH。

## 本地源码安装

开发时仍可使用 file: 依赖，例如：

```json
{ "dependencies": { "dsh-agent-foreman": "file:E:/github project/dsh-agent-foreman" } }
```

pnpm 可能沿用旧硬链接副本。更新后比较 profile/node_modules/dsh-agent-foreman/lib
与源码 lib，确保新增的 native-team.js、team-session.js 都存在且内容一致。
若依赖未重链，先备份并移走旧安装目录，再用当前 profile 的 pnpm install --force 重装；
不要盲目删除配置和台账。完成后重启 DSH。

## 设置与验收

1. 打开「设置 → 包工头」，确认分组名册、完整配置路由和「编辑提示词」按钮可见。
2. 在「派单策略」启用团队模式，给不同承包商分别选择模型并保存。
3. 在会话「工地」查看原生编队运行标识，以及「配置 / 实际」模型。
4. 最小测试只需让指定成员回复一句话；模型自述仅作参考，实际路由查看请求记录。
5. Qoder Global 的 RESOURCE_LIMIT / 排队属于上游资源状态，不应声称已经得到模型回答。

## 配置与数据保留

本版不迁移或清空名册、提示词和派单台账。升级只替换插件文件；请先备份 profile。
从旧版本恢复的运行记录仅供查询和验收，不会自动重新派单。
