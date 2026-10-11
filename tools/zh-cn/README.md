# Bruno 简体中文补丁

本 fork 维护官方 Bruno 安装版的可恢复汉化补丁，当前版本由 `upstream-lock.json` 记录。

- 支持 Windows x64、macOS Apple Silicon；独立补丁无需另装 Node.js。
- 校验官方 ZIP 下载摘要、原始 app.asar 与修改文件的 SHA-256。
- 翻译主要导航、菜单、设置和请求编辑器的静态文案。部分动态错误及第三方文本仍可能为英文。
- 不翻译用户名称、请求及响应数据、脚本、协议值，不改变付费授权。
- Windows 备份原始 app.asar；Mac 保留完整原版及官方签名。检测到应用升级或手工修改会拒绝用旧备份覆盖。

## 下载及使用

从 [本 fork 的 Releases](https://github.com/bilbilmyc/bruno/releases) 下载与已安装 Bruno 版本完全匹配的补丁。每次先保存工作并退出 Bruno。

Windows：右键 `bruno-zh-windows.exe`，选择以管理员身份运行，输入 1 安装汉化，2 恢复，3 检查状态。也可在终端使用：

```powershell
.\bruno-zh-windows.exe apply --app "C:\Program Files\Bruno"
.\bruno-zh-windows.exe restore --app "C:\Program Files\Bruno"
```

Mac：仅支持原生 ARM64 版 Bruno，独立工具要求 macOS 13+。在解压目录中执行：

```bash
chmod +x ./bruno-zh-macos-arm64
sudo ./bruno-zh-macos-arm64 apply --app /Applications/Bruno.app
# 恢复完整原版及原始签名
sudo ./bruno-zh-macos-arm64 restore --app /Applications/Bruno.app
```

Mac 中文副本采用本机 ad-hoc 签名，没有官方公证身份。为加载原始 Electron 框架，主程序保留 hardened runtime 和原始权限，并添加 `disable-library-validation` 权限。不会关闭系统 Gatekeeper。CI 的 M 芯片 macOS 启动验证不等同于下载后的 Gatekeeper 公证验收；首次打开仍可能需要在系统「隐私与安全性」中允许。

请保留备份：Windows 位于 `resources/bruno-zh-backup`；Mac 位于应用旁的 `.Bruno.app.bruno-zh-backup`。Mac 预留至少 2 GB 空间。

## 更新

升级官方 Bruno 前先恢复原版，完成升级后再使用对应新补丁。不要直接把旧补丁用于新版。

本 fork 的 `zh-cn` 分支保存维护工具和审核后的版本清单。上游发布新稳定版本后，维护任务检查差异、补齐词库、核对哈希、运行两个平台的原版/汉化对照与恢复测试，再发布补丁。失败时不发布、不自动覆盖用户的本机安装。

如提示锁文件存在：先关闭所有补丁程序，确认没有 `bruno-zh` 进程，再手动删除报错中指定的 `.bruno-zh.lock` 文件。不要删除备份。Mac 的未完成暂存副本会保留为 `interrupted-时间戳.app` 以便检查。

## 开发

使用 Node.js 24、Python 3.13 和 Bun 1.4.2。在此目录执行 `npm ci --ignore-scripts`，运行 `npm test`。修改词库后，用 `node generate-plans.cjs Windows原版app.asar Mac原版app.asar` 重建清单；再 `npm run build:win` 或 `npm run build:mac` 编译独立程序。

`ci/prepare.py` 下载并校验对应平台官方包。`ci/verify.mjs` 在隔离目录运行原版和汉化版、发送本机 HTTP 请求、保存请求、验证数据不变，并验证原版完整恢复。macOS 必须使用 ARM64 runner。测试不接触日常用户配置，但应用启动可能注册 bruno://；本地测试后需恢复原有协议关联，CI 的一次性机器不受此影响。

公开仓库只包含代码、文案和公开构建元数据。个人配置、备份、日志、测试目录和编译缓存不提交。

这是非官方补丁，不由 Bruno 官方维护。上游代码沿用仓库 MIT 许可证。独立程序内嵌 [Bun 运行时](https://github.com/oven-sh/bun/tree/bun-v1.4.2)。
