# Fork 需求与实现说明

> 本文件说明这个 fork **做什么、改在哪里、为什么**。进度与待办只看
> [`status.md`](status.md)；构建见 [`build.md`](build.md)；上游同步见
> [`upstream-sync.md`](upstream-sync.md)。

## 1. 目标

官方把“第三方云存储同步”（WebDAV / S3 / Google Drive / OneDrive / iCloud）
放在订阅之后，而订阅资格只能从已登录 Readest 账号的 JWT 里读出来。结果是：
未登录用户即使填好了自己的云存储，配置页也打不开、后台同步也不跑（会被判为
`paused`）。

本 fork 的目标：**不注册、不登录，也能把书库、阅读进度、高亮笔记同步到用户
自己的云存储**，并把“必须有官方账号才能用”的入口从界面上撤掉。

官方账号级数据（App 设置、字典/字体、官方翻译/AI 在线服务）不在第三方文件同步
范围。阅读统计使用上游已经落地的本地统计库和展示面板，另加可选的文件同步通道，
不依赖官方账号。设计与数据格式见 [statistics-sync.md](statistics-sync.md)。

## 2. 一个总开关

应用的用户可见名称统一为 **Readest lite**，包括系统应用名称、窗口标题、关于
页面、网页元信息和发布产物；`Readest Cloud` 等官方服务名称、上游链接和版权归属
保留原名称。品牌名称独立于无账号模式开关。

为兼容已安装 fork，保留包标识、二进制名称、URL scheme、签名和所有本地/云端
数据路径。Windows 的产品名同时决定 NSIS 安装目录和卸载项，改名可能使旧的
`Readest` 安装与新名称并存；不自动卸载旧安装。Android 保持 applicationId 与原
签名，继续覆盖升级。

`apps/readest-app/src/utils/access.ts`：

```ts
export const ACCOUNTLESS_BUILD = true; // fork 总开关
export const CLOUD_SYNC_REQUIRES_PREMIUM = !ACCOUNTLESS_BUILD;
export const APP_UPDATES_ENABLED = !ACCOUNTLESS_BUILD;
```

- **恢复官方行为**：把 `ACCOUNTLESS_BUILD` 改成 `false`，所有守卫自动失效。
- 之所以用常量而不是 `SELF_HOSTED` 环境变量：环境变量要在每个构建目标
  （Windows 本地、Android workflow、以后任何构建）都记得设置，漏设就静默失效；
  常量在所有构建下确定生效。
- `isReadestCloudEnabled()` 没有硬关成 `false`：启用任一第三方云存储后，官方
  云同步的派生默认值会自己关闭；硬关会让 13 个上游单测失去意义。这条依赖已写成
  回归测试 `src/__tests__/utils/access-accountless.test.ts`。

## 3. 改动清单

### 3.1 中央开关

| 文件 | 改动 |
| --- | --- |
| `src/utils/access.ts` | 新增 `ACCOUNTLESS_BUILD`；`CLOUD_SYNC_REQUIRES_PREMIUM`、`APP_UPDATES_ENABLED` 由它派生 |
| `src/__tests__/components/settings/cloudSync.test.ts` | 付费墙断言改为“已解除”；资格语义断言改测 `isCloudSyncInPlan` |
| `src/__tests__/utils/access-accountless.test.ts`（新增） | 锁定 fork 契约：未登录（plan=`free`）时后端不被暂停 |

### 3.2 让未登录的同步真正跑起来

| 文件 | 改动 |
| --- | --- |
| `src/app/library/hooks/useLibraryRefresh.ts` | 下拉刷新：只有“一个外部同步源都没启用”时才提示；fork 下改为提示去设置里启用云存储，不再跳登录页 |
| `src/app/library/components/BookItem.tsx` | 封面上的上传/下载按钮去掉“未登录即跳登录”的短路；上传图标改为“有云存储后端 或 已登录且官方云开启”才显示 |
| `src/app/library/page.tsx` | `keepLogin` 记忆跳转不再把用户扔到 `/auth` |

拖拽下拉、设置菜单里的 Sync 行、阅读器内同步、后台自动同步本来就没有账号依赖，
无需改动。

### 3.3 撤掉账号 / 付费入口

每处都是 1 行守卫 + 一句“为什么”注释，没有删除任何官方功能代码。

| 文件 | 撤掉的入口 |
| --- | --- |
| `src/app/library/components/SettingsMenu.tsx` | 整个账号区：Sign In、Account、额度块、Data Sync（官方云配额）、Upgrade to Premium |
| `src/components/settings/IntegrationsPanel.tsx` | 集成页里的 “Readest Cloud” 行、Discord 状态同步开关、“Send to Readest”（邮件收件箱） |
| `src/app/library/components/LibraryEmptyState.tsx` | 空书架上那句 “Sign in to sync your library” |
| `src/app/reader/components/ViewMenu.tsx` | 阅读器同步行未登录时的跳登录，改为提示去设置里启用云存储 |
| `src/app/user/page.tsx` | 未登录 1 秒后跳 `/auth` 的定时跳转（该页已无入口） |
| `src/hooks/useSync.ts` | 拉取失败报 `Not authenticated` 时的跳登录 |
| `src/app/reader/components/tts/TTSPlayerSheet.tsx` | “Offline Audio” 离线音频行（付费功能，本 fork 用不上） |
| `src/app/library/hooks/useAbsOfflineDownload.ts` | Audiobookshelf 离线下载的升级页/登录页跳转 |
| `src/components/localsend/ReceiveRequestDialog.tsx` | Nearby 配对（付费）的升级页/登录页跳转 |

`app/auth/*`、`app/send/page.tsx` 等页面本身保留不动——只是没有任何入口能走到。

### 3.4 翻译

官方四个翻译服务里，只有 **Google 完全免费、不需要账号和密钥**；DeepL 走官方
服务器并按账号算每日额度；Azure(Bing)/Yandex 在 App 上直连免账号，但在网页版
必须走官方代理（要求登录）。所以：

| 文件 | 改动 |
| --- | --- |
| `src/services/constants.ts` | 默认翻译服务 `deepl` → `google` |
| `src/components/settings/LangPanel.tsx` | 设置里的翻译服务下拉框滤掉 `authRequired` 的服务，不再出现 “DeepL (Login Required)” |
| `src/app/reader/components/annotator/TranslatorPopup.tsx` | 划词翻译弹窗用同一套过滤；底部选择器与 “Translated by” 文案改用实际生效的 provider |
| `src/hooks/useTranslator.ts` | provider 解析改为同步（原先在 effect 里，晚一帧）；统一走同一个可用性过滤器；返回值新增 `selectedProvider` |
| `src/__tests__/hooks/useTranslator.test.ts`（新增） | 回归测试：首帧/首次翻译就落在可用 provider 上 |

过滤依据是**静态标志** `authRequired`，不是当前 token：所以 Android 上
Bing/Yandex（直连、免账号）会保留，网页版保留 Google。

**为什么必须同步解析**：弹窗是挂载即发起翻译的，而 `translate()` 读的是
state。原先“渲染一帧后才纠正 provider”的做法，会让第一次请求打到设置里存的
provider——而改默认值不会重写用户已有设置，老配置里存的 `deepl` 在未登录时
直接抛 “Authentication token is required for DeepL translation”。所以解析必须
发生在首次渲染内，且不能只靠默认值。

### 3.5 新增文件（永不与官方冲突）

- `src/utils/accountless.ts` — fork 专用提示（“去设置里启用云存储”），书架与
  阅读器共用一份文案。
- `src/__tests__/utils/access-accountless.test.ts` — 上述回归测试。
- `.github/workflows/fork-build.yml` — Windows + Android 客户端构建，见
  [`build.md`](build.md)。
- 本目录的文档。

### 3.6 移除遥测（PostHog）

官方的匿名使用统计在 fork 里是**彻底移除**，而不是“默认为关”：

| 文件 | 改动 |
| --- | --- |
| `src/context/PHContext.tsx` | `initPostHog()` 在 `ACCOUNTLESS_BUILD` 下直接返回，PostHog 永不初始化；唯一出网口关闭后，所有 `posthog.*` 调用都成为无副作用空操作 |
| `src/utils/telemetry.ts` | `captureEvent()` 与 `optInTelemetry()` 直接返回，任何界面都无法再打开遥测 |
| `src/services/constants.ts` | `telemetryEnabled` 默认 `true` → `false`（兼容旧配置的数据形状） |
| `src/components/settings/ControlPanel.tsx` | 设置里的 Privacy 区块整块不渲染 |
| `src/components/Providers.tsx` | 跳过首次启动的遥测同意决策，使同意弹窗永不出现 |
| `src/services/commandRegistry.ts` | 命令面板里的 `action.telemetry` 动作不注册 |
| 测试（4 个） | 断言 opt-in 被拒绝、命令动作不存在；相关测试补 `@/utils/config` / `@/utils/access` 的 mock |

遗留（可接受）：`posthog-js` 仍留在 bundle 里（未初始化、不出网）；旧安装的
localStorage 决策键可能残留（无副作用）；Sentry 崩溃上报是另一条独立通道，未动。

### 3.7 停掉更新检查

更新检查有两条互不相干的出网路径：

| 路径 | 走哪里 | 由什么配置 |
| --- | --- | --- |
| 桌面（Win / macOS / Linux） | Tauri updater 插件 | `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints` |
| **Android** | 前端自己 `fetch` | `src/services/constants.ts` 的 `READEST_UPDATER_FILE`（写死常量） |
| nightly 通道 | 前端自己 `fetch` 两份 manifest | 同上两个常量 |

所以构建时把 `endpoints` 覆盖成 `[]` 只能静音 Windows，Android 完全不看这个
配置。彻底做法是一处源头开关：`APP_UPDATES_ENABLED = !ACCOUNTLESS_BUILD`，
`src/helpers/updater.ts` 的 `checkForAppUpdates()`（覆盖桌面/Android/nightly）
和 `checkAppReleaseNotes()` 在函数入口直接返回 `false`。

为什么不走构建时环境变量（`NEXT_PUBLIC_DISABLE_UPDATER`）：它只把
`appService.hasUpdater` 置为 false，每个构建目标都要记得设，漏一个就静默失效；
而且 `app/reader/page.tsx` 里 `hasUpdater === false` 的分支会改去调
`checkAppReleaseNotes()`，还是打官方服务器。改常量一行，所有平台、所有构建都
确定生效。

**为什么连官方包也不能“假装更新”**：本 fork 用自己的 keystore 签名，官方 APK
装不上——Android 会以 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`（签名不一致）直接
拒绝覆盖安装，最坏情况是把 fork 装好的书库弄丢。

保留（可接受）：设置里的 “Check for updates automatically” 与 nightly 通道开关
仍在，因为 `hasUpdater` 未改动；点了也没有任何出网行为。

## 4. 能同步 / 不能同步

写入用户自己云存储的 `Readest/` 目录（目录结构见
`src/services/sync/file/layout.ts`）。

### ✅ 能同步

| 内容 | 位置 |
| --- | --- |
| 书库索引：书名、作者、标签、分组、阅读状态、封面索引 | `Readest/library.json` |
| 阅读进度 + 高亮/笔记 | `Readest/books/<hash>/config.json` |
| 电子书文件本体（受每个后端的“上传书籍文件”开关控制） | `Readest/books/<hash>/<书名>.<扩展名>` |
| 封面 | `Readest/books/<hash>/cover.png` |
| 朗读生成的音频包 | `Readest/books/<hash>/tts/*.mp3` + 同名 `.json` |
| 阅读和听书统计（需为对应后端开启“同步阅读统计”） | `Readest/stats/v1/<设备>/<分块>.json` |

统计开关默认关闭，在各存储后端的同步设置中单独开启；统计与书籍是否仍在本机
书库无关。首次同步补传已有历史，后续增量合并，重复读取同一事件不重复累计，
离线时继续本地记录。统计文件为明文，包含书名、作者和具体阅读时间。
本版只合并历史，不提供跨设备清空/删除统计。

### ❌ 不能同步（走官方账号，本 fork 内不可用）

| 内容 | 说明 |
| --- | --- |
| App 全局设置（主题、界面、快捷键…） | 走官方 replica 通道 |
| 字典、字体、背景纹理 | 同上 |
| 每本书的阅读视图设置（字号、版式…） | 官方标注尚未纳入文件同步 |
| 各集成的账号密码 / token（OPDS、KOSync、Readwise、Hardcover…） | 官方凭据同步默认就是关闭的 |
| 翻译、AI 等在线服务、分享链接、官方云存储文件 | 需要官方服务器 |
