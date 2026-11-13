# 安装与升级 · v0.5.0

发布日期：2026-11-13（Asia/Shanghai）。GitHub Release 与 npm 同步发布。

**定位（0.5.0 起）**：DSH 已内置原生「多 Agent 编队」（持久 teammate、peer 消息、共享任务板）。本插件
**不再宣称补齐编队空缺**，而是架在原生能力之上的一层薄编排：**按模型派单 + 逐单独立验收 + 返工闭环**。
两者并存互补，请按实际需求选用，不要叠加同一份活。

**验证范围**：0.5.0 的新增行为（写入范围提示、验收清单、独立签收、团队开关提示、显式团队兜底）由 test/optimization.test.mjs、test/harness.test.mjs 与离线回归
套件验证。0.5.0 包含 DSH `0.2.2-rc.2` 适配：普通激活参数、具名成员、任务归属、取消隔离与真实宿主 ASAR 契约测试；ASAR / headless Chrome 用例需配置路径，否则明确跳过。**未调用真实模型、未启用真实原生编队，也不是运行中的真实浏览器会话端到端测试**。

## 兼容与重要说明

- Node.js：22.19+（22.x）或 24+；宿主声明范围：
  DSH `>=0.2.1-rc.2 <0.3.0-0 || >=0.2.2-0 <0.3.0-0`。
  第二段显式覆盖 `0.2.2` 预发布线，使范围在标准 semver 与宿主 `includePrerelease: true`
  两种判定下都通过（DSH 0.2.2-rc.1 因此不会被入口拒绝）。
- **DSH `0.2.2-rc.2` 公开接口适配已包含在 0.5.0**：普通激活使用平铺参数；团队成员通过具名子智能体创建和复用，任务归属转换成确切的成员会话 ID，取消后只等待该成员空闲。尊重当前会话团队开关，不自动开启。Foreman 的 `teamMode` 与宿主开关都打开时才走原生团队；开启 `teamFallback` 后，宿主团队不可用或开关关闭才会退回普通子会话。
- **旧版兼容桥仍保留**：DSH 0.2.1-rc.5 / 0.2.2-rc.1 使用旧版内部契约；这些宿主不具备 rc.2 的公开具名成员接口时，插件会明确走兼容路径或报告不兼容，不创建替代子会话或偷换父模型。
- 每个承包商可选 provider、模型与思考等级。团队模式同一成员串行，不同成员可以并行。
- 原生编队空闲卡片可能回显父模型的回退标签；实际调用以设置页「实时工地」里的请求配置记录为准。

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
npm install --save-exact dsh-agent-foreman@0.5.0
```

profile 使用 pnpm 管理时沿用 pnpm，不混用锁文件：

```bash
pnpm add --save-exact dsh-agent-foreman@0.5.0
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

GitHub Release 附带 dsh-agent-foreman-0.5.0.tgz，与 npm 发布内容完全相同。
假设下载到 E:/downloads，可在 profile 目录安装：

```bash
npm install --save-exact E:/downloads/dsh-agent-foreman-0.5.0.tgz
# 或沿用该 profile 的 pnpm
pnpm add E:/downloads/dsh-agent-foreman-0.5.0.tgz
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
3. 在「设置 → 包工头 → 实时工地」查看原生编队运行标识，以及「配置 / 实际」模型。
4. 最小测试只需让指定成员回复一句话；模型自述仅作参考，实际路由查看请求记录。
5. Qoder Global 的 RESOURCE_LIMIT / 排队属于上游资源状态，不应声称已经得到模型回答。

## 配置与数据保留

本版不迁移或清空名册、提示词和派单台账。升级只替换插件文件；请先备份 profile。
从旧版本恢复的运行记录仅供查询和验收，不会自动重新派单。
