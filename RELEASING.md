# 发布指南

仓库：<https://github.com/mengwEX/dsh-block-ptc>。包名与 bundle 中的插件解析名
统一为 `dsh-block-ptc`。当前版本为 `0.1.1`，声明最低 DSH 版本为
`0.2.0-rc.2`、最低 Cordis 版本为 `4.0.4`，均不设版本上限。

包已发布到 [npm](https://www.npmjs.com/package/dsh-block-ptc)，维护账号为
`mengw.ex`，用户可直接通过 Plugin Manager 按包名安装。`0.1.1` 增加了浏览器
半边（工具行渲染与 PTC 的 `run_code` 一致）和让它可被加载的宿主层锚点行；
两处都必须在真实宿主里验收，见文末第 4 节。

GitHub Release 与 npm 是两条独立的发布流程。创建 GitHub Release 不会上传 npm，
仓库 CI 也不持有 npm 凭据或自动执行 `npm publish`。

## 1. 发布前检查

在仓库根目录运行（Node.js 22+，无需安装依赖）：

```sh
npm run check
npm pack --dry-run
```

- 更新 `package.json` 版本、`CHANGELOG.md` 和两份 README。
- 确认 `package.json` 的 `name`、插件导出的 `name` 和 `cordis.patch.yml`
  中插件行的 `name` 一致。
- 确认 `files` 包含入口、bundle 补丁、locale、许可证及第三方版权声明。
- 涉及 DSH API 或预设配置的改动，要在目标版本的宿主中安装 bundle、重启应用，
  用 **Block PTC** 新建会话，验证程序委派、收口、消息保留及恢复行为。
- 将真实宿主验收结果与 mock 测试结果分开记录；CI 不代表宿主端到端验收。
- 保持 peer dependencies 只有最低版本要求，不按单个宿主版本锁定，也不增加
  版本上限。另行记录实际验收版本；接口存在检查不能代替宿主行为验收。

DSH peer dependencies 由宿主提供。本地检查不需要运行 `npm install`；这样也避免
为无依赖的测试额外安装整个宿主。

## 2. GitHub Release

确保改动已提交并推送，且该提交的 GitHub Actions 检查通过。首次发布可使用：

```sh
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
npm pack
gh release create v0.1.0 dsh-block-ptc-0.1.0.tgz --verify-tag --title "v0.1.0" --notes-file /absolute/path/to/release-notes.md
```

release notes 应说明功能、安装方式、兼容版本和验证边界。发布后核对仓库的
Releases 页面、tag 指向及附件内容。后续版本应使用对应的新版本号。

## 3. 发布到 npm

只有维护者明确决定上架 npm 时才执行。先确认账号对包名有发布权限，并查询注册表
当前状态；仓库名相同并不保证 npm 包名仍然可用。

```sh
npm whoami
npm view dsh-block-ptc versions --json
npm publish --access public
npm view dsh-block-ptc version
```

未登录时使用 `npm login`，不要将 token 写进仓库。`prepack` 会自动执行语法检查
和逻辑测试。npm 发布成功后再更新 README，说明可直接按包名安装。

## 4. 安装验收与回滚

GitHub 源码安装：

```sh
git clone https://github.com/mengwEX/dsh-block-ptc.git
```

然后在 Harness 的 Plugin Manager 中安装绝对目录：

```
plugin_manager install_bundle /absolute/path/to/dsh-block-ptc
```

安装后重启应用，用 **Block PTC** 预设新建会话。桌面 profile 由桌面应用管理，
应使用应用内 Plugin Manager。包名安装只适用于已发布到 npm 的版本。

验收应确认：

1. preset 可以启动，`block_run_code` 委派到内置 `run_code`。
2. `tools.block_summary` 从程序内部调用，摘要出现在被替换内容的位置。
3. 系统提示和用户消息保留，原始事件仍在会话日志中。

回滚可停用或卸载 bundle 后重启：

```
plugin_manager set_bundle dsh-block-ptc enabled=false
plugin_manager remove_bundle dsh-block-ptc
```

本地开发改动需要重启宿主才能换用新模块。升级 DSH 时重新验证 API、预设和
浏览器渲染；只放宽版本范围或通过接口存在检查，均不能作为兼容验收结论。
