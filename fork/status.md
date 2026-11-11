# Fork 进度（唯一记录）

> 这是本 fork **唯一**的进度记录。需求与实现说明见
> [`requirements.md`](requirements.md)，客户端构建见 [`build.md`](build.md)，
> 与官方同步的步骤见 [`upstream-sync.md`](upstream-sync.md)。
> 不要再新建 `TODO`、`PROGRESS`、`NOTES` 之类的平行文件；所有进度、待办、
> 合并记录都写在这里。

最后更新：2026-11-11

## 当前状态

| 项目 | 值 |
| --- | --- |
| 分支 | `lite` |
| 当前基线 | 官方 `v0.12.20`（`28aab23e0`，2026-11-05 发布） |
| 合并提交 | `dbfcad035` — `Merge tag 'v0.12.20' into lite` |
| 版本号 | `apps/readest-app/package.json` = `0.12.20` |
| fork 开关 | `ACCOUNTLESS_BUILD = true`（`apps/readest-app/src/utils/access.ts`） |
| 远端 | `origin` = `dinayuil/readest`；`upstream` = `readest/readest` |
| 客户端构建 | `.github/workflows/fork-build.yml`，Windows + Android，**每次 push 触发**；两个 job 都成功后自动创建 GitHub Release；Android 签名 secrets 已配置（2026-09-19） |
| 文档入口 | 根目录 [`AGENTS.md`](../AGENTS.md) |

所有 fork 改动都可以用一个词找到：

```bash
grep -rn ACCOUNTLESS_BUILD apps/readest-app/src
```

当前命中 **33 个文件（含 10 个测试文件）、约 92 处**（以实际 grep 结果为准）。
改完或合并后按这个列表逐处复核即可。

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

- [ ] **确认首次 push 触发的 Fork Build**：Windows 与 Android 两个 job 都成功，
      Artifacts 可下载，并自动生成 GitHub Release（tag 形如
      `v0.12.20-lite.<run_number>`）。Android release 需要的三个 secrets 已在仓库中
      （`ANDROID_KEY_BASE64` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`，
      2026-09-19 配置），且此前手动运行成功过
      （run `35930287767`，2026-09-23），所以 release 版应可直接签名；若这次失败，
      再按 [`build.md`](build.md) 排查密钥或构建环境。
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
