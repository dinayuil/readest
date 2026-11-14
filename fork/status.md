# Fork 进度（唯一记录）

> 这是本 fork **唯一**的进度记录。需求与实现说明见
> [`requirements.md`](requirements.md)，客户端构建见 [`build.md`](build.md)，
> 与官方同步的步骤见 [`upstream-sync.md`](upstream-sync.md)。
> 不要再新建 `TODO`、`PROGRESS`、`NOTES` 之类的平行文件；所有进度、待办、
> 合并记录都写在这里。

最后更新：2026-11-14

## 当前状态

| 项目 | 值 |
| --- | --- |
| 分支 | `lite` |
| 应用名称 | `Readest lite`；仓库 `dinayuil/readest-lite` |
| 当前基线 | 官方 `v0.12.20`（`28aab23e0`，2026-11-05 发布） |
| 合并提交 | `dbfcad035` — `Merge tag 'v0.12.20' into lite` |
| 版本号 | `apps/readest-app/package.json` = `0.12.20` |
| fork 开关 | `ACCOUNTLESS_BUILD = true`（`apps/readest-app/src/utils/access.ts`） |
| 远端 | `origin` = `dinayuil/readest-lite`；`upstream` = `readest/readest` |
| 客户端构建 | `.github/workflows/fork-build.yml`，Windows + Android，**每次 push 触发**；两个 job 都成功后自动创建 GitHub Release；Android 签名 secrets 已配置（2026-09-19） |
| 文档入口 | 根目录 [`AGENTS.md`](../AGENTS.md) |

无账号模式的 fork 改动可搜索下列开关；应用品牌改动还需检查 `Readest lite`：

```bash
grep -rn ACCOUNTLESS_BUILD apps/readest-app/src
```

当前命中 **33 个文件（含 10 个测试文件）、约 92 处**（以实际 grep 结果为准）。
改完或合并后按这个列表逐处复核即可。

## 应用与仓库改名（2026-11-12）

- GitHub 仓库已改为 `dinayuil/readest-lite`，本地 `origin` 已更新，Description
  说明免账号云同步和 Windows/Android 构建。README 改为介绍本 fork 的特点、下载、
  同步限制和开发入口，保留上游归属与 AGPL 许可。
- 应用名称统一为 `Readest lite`：原生产品名、窗口、关于入口、Web/PWA 元信息、
  iOS 扩展/小组件/CarPlay 的显示名称，以及 Release 标题。
- 下载文件改为 `Readest-lite-*`，Artifacts 改为 `readest-lite-*`；Windows 工作流
  已同步适配含空格的 `Readest lite_*` 原始安装包名称。
- 保留包标识、binary/crate/target 名称、协议、签名和本地/云端数据目录；Windows
  可能留下旧产品名的安装项。没有自动卸载逻辑。官方服务名与归属链接保留。
- 验证：相关 7 个测试文件 118 项通过，`tsc --noEmit` 通过；修改的 TS/TSX/JSON
  格式检查通过，工作流 YAML 与产品名/标识静态检查通过。原生安装包实际名称和
  启动标签待本次 CI 构建及设备安装验证。
- 改名提交 `3918ef45d` 的首次普通 push 被 pre-push 拦截：格式、类型、lint 通过，
  全量测试 15838 passed / 3 failed，仍集中在 Open Graph 与 TTS 段落预加载两个
  测试文件。修复后普通 push 已成功，远端提交 `bd561f780`；完整 pre-push 的格式、
  类型、lint 均通过，1289 个测试文件通过（4 skipped），15841 项测试通过
  （16 skipped）。改名后的 CI run `43312151174` 已触发。
- 测试修复仅涉及测试代码：Open Graph 子进程 import 使用 `pathToFileURL`；TTS 的
  `flush()` 改用 `setImmediate` 保留 20 次事件循环让步。诊断证明旧测试在 Windows
  的 444 步执行需 135.6 秒，所有段落均正常结束，超时后的异步残留污染后续断言。
  修复后 9 项相关测试通过，TTS 文件连续 5 次通过，断言与 60 秒预算均未放宽。
- 增加 `README.en.md`，与中文 `README.md` 互相链接；GitHub Description 同时
  提供中英文简介。两份 README 均只介绍产品与用法，不另建进度记录。

## 本轮合并记录：v0.12.20

- `lite` 与 `v0.12.20` 之间原有 **513 个上游提交**，`git diff` 约 1366 个文件。
- 合并产生 **14 个冲突**：13 个内容冲突 + 1 个上游删除的测试文件
  （`ControlPanelGamepad.test.tsx`，fork 只改过它的 mock，接受删除）。
- 冲突全部按“保留上游实现 + 重新加回 fork 守卫”处理，`tsc`、格式检查与
  全量单测见下方验证。

### 上游结构变化与 fork 适配

| 上游变化 | fork 处理 |
| --- | --- |
| 下拉刷新从 `library/page.tsx` 移到新钩子 `useLibraryRefresh.ts` | 把原来的“未登录且无同步源时提示去设置”逻辑移进新钩子；页面只保留 `keepLogin` 守卫 |
| `PHContext` 改为 `initPostHog()` 延迟初始化，`Providers` 在设置加载后调用 | fork 守卫放进 `initPostHog()` 入口；`Providers` 同时跳过遥测同意决策与 init |
| `useTranslator` 增加自定义翻译服务、premium 参数与 prompt 上下文 | 保留上游实现，继续用同步解析器 `resolveAvailableProvider`；保留返回的 `selectedProvider` |
| `TranslatorPopup` / `LangPanel` 增加 premium 过滤与自定义服务 | 在过滤链上叠加 `!ACCOUNTLESS_BUILD || !t.authRequired`，两处选择器保持一致 |
| `IntegrationsPanel` 把 Nearby BookDrop 移到 “Local Network” 独立区块 | 采用新结构；“Send to Readest” 行仍由 fork 守卫隐藏 |
| `user/page.tsx` 改用 `navigateBackFromProfile` | 采用上游返回逻辑；保留“未登录 1 秒跳 `/auth`”的 fork 守卫 |
| `DEFAULT_TRANSLATOR_CONFIG` 新增 `translationPromptId` | 保留 fork 的 `translationProvider: 'google'`，同时加入新字段 |
| `TTSPlayerSheet` 上游新增 free/signed-out 的 Premium 路由测试 | 本 fork 隐藏整行，保留 fork 的 accountless 契约测试，不再保留那两条上游测试 |
| 上游删除 `ControlPanelGamepad.test.tsx` | 接受删除（fork 在该文件只补过 mock） |
| `library/page.tsx` 的 `usePullToRefresh` 导入/调用整体消失 | 删除 fork 遗留的旧块、`hasFileSyncMirror`/`navigateToLogin` 导入 |

### 本轮额外调整

- `.github/workflows/fork-build.yml`：新增 `push` 触发（每次 push 构建
  Windows + Android），保留手动 `workflow_dispatch` 覆盖项；`push` 时
  `inputs.*` 为空，所有架构/ABI/变体都已补默认值（x64 / universal / release）。
- 新增 `release` job：`lite` 分支 push 且 Windows/Android 两个构建都成功后，
  把 exe/apk 发布到 GitHub Release；tag 为 `v<版本>-lite.<run_number>`，重跑同一
  次 workflow 会更新该 release 而不是报错。手动运行只留 Artifacts，不自动发布。
- 停止每日/每周定时构建：`android-e2e.yml`、`codeql.yml`、`nightly.yml`、
  `nix-update-inputs.yml`、`scorecard.yml` 的 `schedule` 触发已移除；需要时仍可
  手动运行。
- `.workbuddy/` 与 `apps/readest-app/FORK.md`、`TODOS.fork.md` 已删除；内容
  迁入本目录。`.gitignore` 中对应的 `.workbuddy/` 条目也已移除。

## 验证记录（2026-11-11）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm -C apps/readest-app exec tsc --noEmit` | ✅ 0 错误 |
| 格式 | `pnpm -C apps/readest-app format:check` | ✅ 0 错误 |
| fork 相关单测 | 12 个文件（access/telemetry/translator/updater/TTS/library 等） | ✅ 227 passed |
| 全量单测 | `pnpm -C apps/readest-app test` | ⚠️ 15839 passed / 2 failed（均为上游 Windows 环境问题，见下） |
| 依赖 | `pnpm install` | ✅ 完成 |
| 子模块 | `git submodule update --init --recursive` | ✅ foliate-js / webview-upgrade 已对齐 v0.12.20 指针 |

全量单测剩下的 2 个失败**与本 fork 无关**，两个测试文件相对 `v0.12.20` 没有任何
改动（`git diff v0.12.20 -- <file>` 为空），是上游测试在 Windows 上的已知环境问题：

- `src/__tests__/dependency-og-runtime.test.ts`：测试把 Windows 绝对路径直接交给
  Node ESM `import()`，报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（需要 `file://` URL）。
- `src/__tests__/services/tts-paragraph-boundary.test.ts`：60 秒超时。测试用
  `setTimeout(0)` 轮询，Windows 定时器精度约 15 ms，长循环下超过时限；单独跑也会
  偶发。不是 fork 代码路径。

fork 自身的契约测试（access / translator / updater / telemetry / TTS 行 /
library refresh / ABS offline）全部通过。

## 待办（唯一待办清单）

### 第三方阅读统计同步

设计与约束见 [statistics-sync.md](statistics-sync.md)。用户已批准按建议实现。

- [x] 实现统计历史回填、增量确认与不可变文件分块，验证重复合并、时长增长、
      离线重试和多设备并发。
- [x] 接入各后端设置和同步触发，验证关闭、发送/接收策略、目标切换和故障隔离。
- [x] 增加统计同步设置开关与说明，接入手动同步并验证。
- [x] 完成集成验证并更新中英文使用说明及范围文档。
- [ ] 在发布的新版本上，使用两台设备连接同一 WebDAV 目录验证真实服务端同步。

首轮相关 22 个测试文件 / 183 项测试通过；类型检查通过。覆盖统计增量确认、文件
通道、目标身份、设置开关、手动/自动同步、阅读/TTS 与统计面板入口；测试使用
真实内存 SQLite 和内存 Provider，没有写入用户的 WebDAV。

最终审查修复范围：统一所有本地写入与同步事务的写入门，避免回滚丢失并发阅读
事件；逐块拉取控制内存；验证本地产物可被接收端解码；本机上传路径预登记避免
上传成功但确认失败后的旧元信息回灌；目录身份与实际路径规则一致；中途关闭或
切换目标后停止后续 I/O。已修复重复 md5 的历史行导致上传不结束的问题。
首轮完整检查通过格式和类型/lint，测试在并行修改时有 4 条已修复的回归用例失败，
不能作为最终结果。固定代码后的集成检查：25 个测试文件 / 228 项通过，覆盖现有
统计、备份和官方同步回归；完整格式、类型/lint 与测试套件由正常推送的 pre-push
再次执行，不绕过检查。真实服务端/双设备联调保留为上述待办。

- [x] **Android APK 解析失败排查（2026-11-14）**：Redmi 12 Turbo / HyperOS 3.0.5.0 /
      Android 15 安装 `v0.12.20-lite.8` 提示 `(33) packageInfo is null`。经用户授权
      通过 USB 检查，手机文件大小与发布包均为 215795263 字节，但手机副本 SHA-256
      为 `f01d48ae2739ed7f4dbac66fa11980b9070b79cfcc0e7fb34e1fd9df93def711`，
      正确发布包为 `007837845a5714d4dec866e16c62adbf72005d1eb4ab4c0e549175f82f7be3cc`。
      手机副本 v2 签名完整性校验失败（CHUNKED_SHA256 digest mismatch），ZIP CRC
      检查也失败；已确认文件内容损坏，损坏发生在哪个下载/传输环节尚不明确。
      使用已验证原包 `adb install -r` 成功，原安装从 0.12.10 / versionCode 12010
      升到 0.12.20 / 12020，无卸载、无数据清除。手机下载目录旧文件保留为
      `.apk.corrupt`，正确 APK 已重新传入并校验与 GitHub digest 一致。

- [ ] **应用改名后的构建验证**：核验 `Readest lite` 的 Windows 安装包名称、
      Android 应用标签、窗口与关于页面，以及自动 Release 的标题和产物。

- [x] **确认首次 push 触发的 Fork Build**：run `43115481535` 的 Windows、Android、
      Release 三个 job 全部成功，已发布 `v0.12.20-lite.6`，含 setup.exe、portable.exe
      与签名 APK。2026-11-12 已通过 GitHub API 核验。
- [ ] **迁移存量 `translationProvider`**：默认值只影响新装；老配置里仍是
      `deepl`。翻译行为和选择器显示已经由同步解析修正，但设置文件里仍写着
      不可用的值。彻底做法是在 `appService.runMigrations` 加一条 fork 迁移
      （版本闸门 `< 20260919`），把不可用的值改写为首个可用 provider。优先级低。
- [ ] **（可选）隐藏手动更新入口**：源码层 `APP_UPDATES_ENABLED` 已让
      `checkForAppUpdates()` / `checkAppReleaseNotes()` 全部早返回；“关于”窗口
      的按钮和设置里的自动更新/nightly 开关仍在。要彻底隐藏需改
      `AboutWindow.tsx` 与 `ControlPanel.tsx`（记得补 `@/utils/access` 的 mock）。
- [ ] **Google Drive / OneDrive OAuth**：如要使用，需要自己申请 OAuth 应用并用
      `NEXT_PUBLIC_GOOGLE_CLIENT_ID` / `NEXT_PUBLIC_MICROSOFT_CLIENT_ID` 替换；
      桌面端还要同步改 `src-tauri/tauri.conf.json` 的反向 DNS 回调 scheme。
      WebDAV / S3 不需要申请任何东西。
- [ ] **下一次上游发布**：按 [`upstream-sync.md`](upstream-sync.md) 再合并；
      合并记录继续追加到本文件。

## 已知取舍

- `posthog-js` 仍留在 bundle 中，但 `initPostHog()` 永不初始化（未出网）；Sentry
  崩溃上报是独立通道，未改动。
- 官方账号页 `/auth`、`/user`、`/send` 等页面代码保留，只是没有任何入口能走到；
  这样上游合并冲突面最小。
- 更新检查在源码层关闭（桌面 Tauri updater、Android 手工请求、nightly 通道）；
  构建配置里的 `plugins.updater.endpoints: []` 只作为桌面侧第二道防线。
- Android 使用 fork 自己的 keystore；换钥匙会导致已安装包无法覆盖升级。
- 本 fork 只跟踪官方**发布 tag**，不跟 `upstream/main`；发布版之间的提交不保证
  已合并。
