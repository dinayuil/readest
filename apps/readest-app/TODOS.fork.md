# Fork TODO — 无账号构建（ACCOUNTLESS_BUILD）

本文件只属于这个 fork；官方仓库没有它，所以官方更新永远不会在这里产生冲突。

**所有 fork 改动都可以用一个词找到**：

```bash
grep -rn ACCOUNTLESS_BUILD apps/readest-app/src
```

官方上游 rebase / merge 之后，照这个清单逐处复核即可，不会漏。

---

## 1. 这个 fork 要解决什么

官方把"第三方云存储同步"（WebDAV / S3 / Google Drive / OneDrive / iCloud）放在订阅之后，而订阅资格**只能从已登录 Readest 账号的 JWT 里读出来**。结果是：未登录用户即使填好了自己的云存储，配置页打不开、后台同步也不跑（会被判为 `paused`）。

目标：**不注册、不登录，也能把书库、阅读进度、高亮笔记同步到用户自己的云存储**，并把"必须有官方账号才能用"的入口从界面上撤掉。

不做的事：官方账号级数据（App 设置、阅读统计、字典/字体、翻译/AI 在线服务）不在本次范围，见第 5 节。

---

## 2. 一个开关

`src/utils/access.ts`：

```ts
export const ACCOUNTLESS_BUILD = true;                        // fork 总开关
export const CLOUD_SYNC_REQUIRES_PREMIUM = !ACCOUNTLESS_BUILD; // 由它派生，勿单独改
```

- **恢复官方行为**：把 `ACCOUNTLESS_BUILD` 改成 `false` 即可（其它守卫全部自动失效）。
- 之所以改这个常量而不是用 `SELF_HOSTED` 环境变量：环境变量要在**每个构建目标**（Windows 本地、Android workflow、以后任何构建）都记得设置，漏设就静默失效；改常量同样是一行，但在所有构建下确定生效，而且官方注释本身就把这个常量称作"整个开关"。
- 之所以没有把 `isReadestCloudEnabled()` 硬关成 `false`：启用任一云存储后端后，官方云同步的**派生默认值**（`settings.readestCloud.enabled ?? !hasAnyThirdPartyEnabled(settings)`）自己就会变成关闭，已经够用；硬关会让 13 个上游单测失去意义。这条依赖已写成回归测试 `src/__tests__/utils/access-accountless.test.ts`，被改坏会立刻报错。

---

## 3. 改动清单

### 3.1 中央开关（1 个文件）

| 文件 | 改动 |
| --- | --- |
| `src/utils/access.ts` | 新增 `ACCOUNTLESS_BUILD`；`CLOUD_SYNC_REQUIRES_PREMIUM` 由它派生 |
| `src/__tests__/components/settings/cloudSync.test.ts` | 付费墙断言改为"已解除"；资格语义断言改测 `isCloudSyncInPlan` |
| `src/__tests__/utils/access-accountless.test.ts`（新增） | 锁定 fork 契约：未登录（plan=`free`）时后端不被暂停 |

### 3.2 让未登录的同步真正跑起来（2 个文件）

| 文件 | 改动 |
| --- | --- |
| `src/app/library/page.tsx` | 下拉刷新：只有"一个云存储后端都没启用"时才提示（原本一律跳登录页，现在改为提示去设置里启用）；`keepLogin` 记忆跳转不再把用户扔到 `/auth` |
| `src/app/library/components/BookItem.tsx` | 封面上的上传/下载按钮去掉"未登录即跳登录"的短路；上传图标改为"有云存储后端 或 已登录且官方云开启"才显示（避免点出一个注定失败的官方上传） |

拖拽下拉、设置菜单里的 Sync 行、阅读器内同步、后台自动同步本来就没有账号依赖，无需改动。

### 3.3 撤掉账号 / 付费入口（9 个文件）

每处都是 1 行守卫 + 一句"为什么"注释，没有删除任何官方功能代码。

| 文件 | 撤掉的入口 |
| --- | --- |
| `src/app/library/components/SettingsMenu.tsx` | 整个账号区：Sign In、Account、额度块、Data Sync（官方云配额）、Upgrade to Premium |
| `src/components/settings/IntegrationsPanel.tsx` | 集成页里的 "Readest Cloud" 行、Discord 状态同步开关、"Send to Readest"（邮件收件箱） |
| `src/app/library/components/LibraryEmptyState.tsx` | 空书架上那句 "Sign in to sync your library" |
| `src/app/reader/components/ViewMenu.tsx` | 阅读器同步行未登录时的跳登录，改为提示去设置里启用云存储 |
| `src/app/user/page.tsx` | 未登录 1 秒后跳 `/auth` 的定时跳转（该页已无入口） |
| `src/hooks/useSync.ts` | 拉取失败报 `Not authenticated` 时的跳登录 |
| `src/app/reader/components/tts/TTSPlayerSheet.tsx` | "Offline Audio" 离线音频行（付费功能，本 fork 用不上） |
| `src/app/library/hooks/useAbsOfflineDownload.ts` | Audiobookshelf 离线下载的升级页/登录页跳转 |
| `src/components/localsend/ReceiveRequestDialog.tsx` | Nearby 配对（付费）的升级页/登录页跳转 |

`app/auth/*`、`app/send/page.tsx` 等页面本身保留不动——只是没有任何入口能走到它们了。

### 3.4 翻译（3 个文件）

官方四个翻译服务里，只有 **Google 完全免费、不需要账号和密钥**；DeepL 走官方服务器并按账号算每日额度；Azure(Bing)/Yandex 在 App 上直连免账号，但在网页版必须走官方代理（要求登录）。所以：

| 文件 | 改动 |
| --- | --- |
| `src/services/constants.ts` | 默认翻译服务 `deepl` → `google` |
| `src/components/settings/LangPanel.tsx` | 设置里的翻译服务下拉框滤掉 `authRequired` 的服务，不再出现 "DeepL (Login Required)" |
| `src/app/reader/components/annotator/TranslatorPopup.tsx` | 划词翻译弹窗用同一套过滤；底部选择器与"Translated by"文案改用**实际生效**的 provider |
| `src/hooks/useTranslator.ts` | provider 解析改为**同步**（原先在 effect 里，晚一帧），并统一走同一个可用性过滤器 |
| `src/__tests__/hooks/useTranslator.test.ts`（新增） | 回归测试：首帧/首次翻译就落在可用 provider 上 |

过滤依据是**静态标志** `authRequired`，不是当前 token：所以 Android 上 Bing/Yandex（直连、免账号）会保留，网页版保留 Google。

**为什么必须同步解析**：弹窗是挂载即发起翻译的，而 `translate()` 读的是 state。原先"渲染一帧后才纠正 provider"的做法，会让第一次请求打到设置里存的 provider —— 而**改默认值不会重写用户已有的设置**，老配置里存的 `deepl` 在未登录时直接抛 "Authentication token is required for DeepL translation"。所以解析必须发生在首次渲染内，且不能只靠默认值。

### 3.5 新增文件（永不与官方冲突）

- `src/utils/accountless.ts` — fork 专用提示（"去设置里启用云存储"），书架与阅读器共用一份文案。
- `src/__tests__/utils/access-accountless.test.ts` — 上述回归测试。
- `.github/workflows/fork-android.yml` — 见第 6 节。

---

## 4. 能同步 / 不能同步

写入用户自己云存储的 `Readest/` 目录（目录结构见 `src/services/sync/file/layout.ts`）。

### ✅ 能同步

| 内容 | 位置 |
| --- | --- |
| 书库索引：书名、作者、标签、分组、阅读状态、封面索引 | `Readest/library.json` |
| 阅读进度 + 高亮/笔记 | `Readest/books/<hash>/config.json` |
| 电子书文件本体（受每个后端的"上传书籍文件"开关控制） | `Readest/books/<hash>/<书名>.<扩展名>` |
| 封面 | `Readest/books/<hash>/cover.png` |
| 朗读生成的音频包 | `Readest/books/<hash>/tts/*.mp3` + 同名 `.json` |

### ❌ 不能同步（走官方账号，本 fork 内不可用）

| 内容 | 说明 |
| --- | --- |
| App 全局设置（主题、界面、快捷键…） | 走官方 replica 通道 |
| **阅读统计**（每天读了多久、多少页） | 见第 5 节 |
| 字典、字体、背景纹理 | 同上 |
| 每本书的阅读视图设置（字号、版式…） | 官方标注尚未纳入文件同步 |
| 各集成的账号密码 / token（OPDS、KOSync、Readwise、Hardcover…） | 官方凭据同步默认就是关闭的 |
| 翻译、AI 等在线服务、分享链接、官方云存储文件 | 需要官方服务器 |

---

## 5. TODO

### 5.1 阅读统计走文件同步（主要待办）

**现状**：统计写在本地 SQLite（`services/statistics/statisticsDb.ts`），同步走官方接口 —— `services/statistics/statsSync.ts` 的 `pushStats` / `pullStats` 用 `libs/sync.ts` 的 `SyncClient`，入口在 `app/reader/components/ReadingStatsTracker.tsx`，且被 `!!user` 挡住（`syncEnabled = () => !!user && isSyncCategoryEnabled('stats')`）。

**有利条件**（说明这件事不是从零开始）：

- `pushStats(stats, client)` / `pullStats(stats, client)` 的 `client` 参数是**抽象接口**（`Pick<SyncClient, 'pushChanges' | 'pullChanges'>`），换一个实现即可。
- `StatisticsDb.applyRemoteEvents()` 已经是**幂等 upsert**（重复事件不会重复计数，有单测）。
- 页面事件的合并天然是**并集**，不需要冲突解决。

**难点**：

- 现在的水位游标是**服务端盖的时间戳** `updated_at_ms`；文件方案要自己定水位（例如每设备一个 append-only 文件 + 记录已应用到的最大值）。
- 历史很长时要分片（现在靠 `PUSH_CHUNK=500` / `PULL_PAGE=1000` 两次请求，文件方案需要等价的分块与可恢复）。
- 需要接进 `ReadingStatsTracker` 的生命周期，并处理"多设备同时写同一文件"的覆盖问题（每设备一个文件可以绕开写冲突）。
- 官方 `TODOS.md` 里本来就有一条同类条目：「File-engine parity: reading stats + per-book viewSettings sync via the file layout (M)」——官方自评也是**中等**工作量，不是小改。

**现成替代**：`services/bookorbit/statsPush.ts` 会把同样的统计推给自建的 BookOrbit 服务，**不需要 Readest 账号**，现在就能用。

### 5.2 其它

- [ ] **把存量的 `translationProvider` 迁移掉（仅影响观感）**：默认值改动只影响新装；老配置里仍是 `deepl`。翻译行为与两个选择器的显示都已经通过同步解析修正，但设置文件里存的值仍写着 `deepl`。彻底的做法是加一条 fork 迁移（`appService.runMigrations` 里 `< 20260919` 的版本闸门 + 一个小函数），把不能在本构建运行的值改写为首个可用者。优先级低。

- [ ] **遥测确认**：`apps/readest-app/.env` 里带着官方 PostHog 的默认 key，App 启动后可能把使用数据发到官方的 PostHog 项目。这个 fork 的用户可能不希望如此，需要确认上报开关（设置项/环境变量）并考虑关闭。
- [ ] **WebDAV / S3 在网页版受浏览器跨域限制**：需要云存储侧返回 `Access-Control-Allow-*`（Nextcloud、Aliso 等可配置；S3/R2 需配 bucket CORS）。App（桌面/安卓）没有这个限制。若长期只在网页版用，可以考虑给 WebDAV 加一个同源代理。
- [ ] **Google Drive / OneDrive 需要自己申请 OAuth 应用**：代码里烘焙的 client id 绑定了官方回调地址，自建版本要用 `NEXT_PUBLIC_GOOGLE_CLIENT_ID` / `NEXT_PUBLIC_MICROSOFT_CLIENT_ID` 换成自己申请的（桌面端还要同步改 `src-tauri/tauri.conf.json` 里的反向 DNS 回调 scheme）。**WebDAV / S3 不需要申请任何东西。**
- [ ] 安卓端 iCloud 不可用（仅 Apple 平台）。
- [ ] 若想让"已登录用户"仍看到官方账号入口（本 fork 目前对所有人隐藏），把相应守卫从 `ACCOUNTLESS_BUILD` 改为 `ACCOUNTLESS_BUILD && !user` 即可。

---

## 6. Android 构建

官方 `.github/workflows/release.yml` / `nightly.yml` 都会打 Android 包，**但它们的签名步骤依赖仓库 secrets**（`ANDROID_KEY_BASE64`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`、`TAURI_SIGNING_PRIVATE_KEY`、以及上传用的 R2 凭据）。fork 里没有这些，直接跑会在 50 分钟构建的最后一步失败。

所以本 fork 有专用工作流：**`.github/workflows/fork-android.yml`**（新文件，不参与官方合并）。

**用法**：GitHub → 你的 fork → Actions → 左侧 "Fork Android APK" → Run workflow → 选分支和 ABI → 跑完在 Artifacts 里下载 `readest-fork-android-<abi>`。

- 产出的是**调试签名 APK**，可以直接侧载安装（不需要你准备任何签名密钥）。
- ABI 选 `universal` 兼容所有机型；选 `arm64` 体积更小，覆盖现代手机。
- 首次冷构建约 50 分钟（上游实测），之后有 rust-cache 会快很多。
- 想改成发布签名版：在 `src-tauri/gen/android` 生成后写入 `keystore.properties` 并用 `apksigner`/`tauri signer` 签名，或把 keystore 与密码放进 fork 的 secrets，再照抄上游 release.yml 的签名步骤。
- 本地构建需要 Rust + Android SDK + NDK 28.2.13676358（首次同样约 50 分钟）；只装 Rust 是跑不起来的，不建议。

---

## 7. 与官方同步（merge 提示）

```bash
git remote add upstream https://github.com/readest/readest.git
git fetch upstream
git merge upstream/main        # 在 fork 分支上
grep -rn ACCOUNTLESS_BUILD apps/readest-app/src   # 逐处复核
```

冲突面主要在 UI 组件（3.3 的 9 个文件）——这是本 fork 唯一的代价。所有 fork 逻辑都集中在中央开关 + 每处 1 行守卫，重定位成本很低。
