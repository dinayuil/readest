# Readest fork 说明 — 无账号构建（ACCOUNTLESS_BUILD）

本文件说明这个 fork 做了什么、怎么构建、怎么和官方同步。**待办清单在 `TODOS.fork.md`**。

两个文件都只属于这个 fork（官方仓库没有它们），所以官方更新永远不会在这里产生冲突。

**所有 fork 改动都可以用一个词找到**：

```bash
grep -rn ACCOUNTLESS_BUILD apps/readest-app/src
```

官方上游 rebase / merge 之后，照下面第 3 节的清单逐处复核即可，不会漏。

---

## 1. 这个 fork 要解决什么

官方把"第三方云存储同步"（WebDAV / S3 / Google Drive / OneDrive / iCloud）放在订阅之后，而订阅资格**只能从已登录 Readest 账号的 JWT 里读出来**。结果是：未登录用户即使填好了自己的云存储，配置页打不开、后台同步也不跑（会被判为 `paused`）。

目标：**不注册、不登录，也能把书库、阅读进度、高亮笔记同步到用户自己的云存储**，并把"必须有官方账号才能用"的入口从界面上撤掉。

不做的事：官方账号级数据（App 设置、阅读统计、字典/字体、翻译/AI 在线服务）不在本次范围，见第 4 节。其中阅读统计官方自己都还没做完展示，本 fork 不自造轮子 —— 等官方落地再看它怎么同步。

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
- 同一个开关也**停掉遥测**（PostHog 完全不初始化、上报入口被拦、界面开关与命令面板动作一并撤掉），见 3.6。
- 同一个开关也**停掉应用内更新检查**（含桌面 Tauri updater、安卓那条手工请求、nightly 通道），见 3.7。

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
- `.github/workflows/fork-build.yml` — Windows + Android 客户端构建，见本文第 5 节。
- `FORK.md`（本文件）与 `TODOS.fork.md` — fork 的说明与待办。

### 3.6 移除遥测（PostHog）

官方的匿名使用统计（设置 → Privacy → "Help improve Readest"）在本 fork 里是**彻底移除**，而不是"默认为关"：

| 文件 | 改动 |
| --- | --- |
| `src/context/PHContext.tsx` | **永不初始化 PostHog**（`!ACCOUNTLESS_BUILD` 守卫）。这是唯一的出网口，因此既不发 capture 也不发 `/decide`；上游本来就在 dev 模式或缺 key 时不初始化，所以其它 `posthog.*` 调用点照跑无碍 |
| `src/utils/telemetry.ts` | 上报入口 `captureEvent()` 直接返回；`optInTelemetry()` 也直接返回，保证**任何界面都无法再打开遥测** |
| `src/services/constants.ts` | `telemetryEnabled` 默认 `true` → `false`（只为兼容旧配置的数据形状；旧安装里存的 `true` 由上面的 init 守卫兜住） |
| `src/components/settings/ControlPanel.tsx` | 设置里的 Privacy 区块（那个开关）整块不渲染 |
| `src/components/Providers.tsx` | 跳过首次启动的遥测同意决策，同时使同意弹窗永不出现（`TelemetryConsentDialog` 因此成为死代码） |
| `src/services/commandRegistry.ts` | 命令面板里的 `action.telemetry` 动作不注册（标签条目保留，避免动上游的注册表结构与测试） |
| 测试（4 个） | `utils/telemetry.test.ts` 断言改为"opt-in 被拒绝"；`services/command-registry-extended.test.ts` 断言该动作**不**存在；两个 `components/settings/ControlPanel*.test.tsx` 补全 `@/utils/config` 的 mock（新增的 `@/utils/access` 依赖会在模块作用域求值 `services/constants.ts`） |

遗留（可接受）：`posthog-js` 仍留在 bundle 里（未初始化、不出网）；旧安装的 localStorage 决策键可能残留（无副作用）；`sentry`（崩溃上报）是另一条独立通道，本次未动。

### 3.7 停掉更新检查（2 个文件）

更新检查有**两条互不相干的出网路径**，只堵一条没用：

| 路径 | 走哪里 | 由什么配置 |
| --- | --- | --- |
| 桌面（Win / macOS / Linux） | Tauri updater 插件 | `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints` |
| **安卓** | 前端自己 `fetch` | `src/services/constants.ts` 的 `READEST_UPDATER_FILE`（`https://download.readest.com/releases/latest.json`，写死的常量） |
| nightly 通道 | 前端自己 `fetch` 两份 manifest | 同上两个常量 |

所以构建时把 `endpoints` 覆盖成 `[]` 只能静音 Windows，**安卓完全不看这个配置**——这正是"已经改了构建配置，APK 仍然弹官方更新"的原因。

彻底做法是一处源头开关：`src/utils/access.ts` 新增 `APP_UPDATES_ENABLED = !ACCOUNTLESS_BUILD`，`src/helpers/updater.ts` 的 `checkForAppUpdates()`（顺带覆盖安卓分支与 nightly 通道）和 `checkAppReleaseNotes()` 在函数入口直接返回 `false`：

| 文件 | 改动 |
| --- | --- |
| `src/utils/access.ts` | 新增 `APP_UPDATES_ENABLED`，由 `ACCOUNTLESS_BUILD` 派生 |
| `src/helpers/updater.ts` | 两个入口早返回：不发请求、不写 `lastAppUpdateCheck` 时间戳、不弹更新窗 |
| `src/__tests__/helpers/updater.test.ts` | mock 这个开关（`vi.hoisted`，默认 ON 保留上游用例），新增 5 个用例断言 OFF 时零出网 |

为什么不走"构建时环境变量"（`NEXT_PUBLIC_DISABLE_UPDATER`）：它只把 `appService.hasUpdater` 置为 false，**每一处构建目标都要记得设**，漏一个就是静默失效（§2 里同一条理由）；而且 `app/reader/page.tsx` 里 `hasUpdater === false` 的分支会改去调 `checkAppReleaseNotes()`——还是打官方服务器。改常量一行，所有平台、所有构建都确定生效。

**为什么必须连官方包也不能"（假装）更新"**：本 fork 用自己的 keystore 签名，官方 APK 装不上 —— Android 会以 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`（签名不一致）直接拒绝覆盖安装，最坏情况是把 fork 装好好书库给弄丢。这条推送除了误导没有第二种结果。

保留（可接受）：设置里的 "Check for updates automatically" 与 nightly 通道开关仍在（`ControlPanel`），因为 `hasUpdater` 未改动；点了也没有任何出网行为。想彻底隐藏再去动那一处。

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
| **阅读统计**（每天读了多久、多少页） | 官方连展示都还没做完，本 fork 暂不自建文件方案：等官方落地，照它那时的同步方式接 |
| 字典、字体、背景纹理 | 同上 |
| 每本书的阅读视图设置（字号、版式…） | 官方标注尚未纳入文件同步 |
| 各集成的账号密码 / token（OPDS、KOSync、Readwise、Hardcover…） | 官方凭据同步默认就是关闭的 |
| 翻译、AI 等在线服务、分享链接、官方云存储文件 | 需要官方服务器 |

---

## 5. 客户端构建（Windows + Android）

### 为什么需要自己的工作流

官方 `release.yml` / `nightly.yml` 两个客户端都会打，**但它们的签名与上传步骤依赖仓库 secrets**：Android 的 keystore（`ANDROID_KEY_BASE64` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`）、更新签名（`TAURI_SIGNING_PRIVATE_KEY`）、上传用的 R2 凭据。fork 里没有这些，直接跑会在构建的最后一步失败。而且更早就会卡住：`tauri.conf.json` 开着 `createUpdaterArtifacts: true`，没有签名密钥**连 Windows 构建都过不去**。

所以本 fork 有一个专用工作流：**`.github/workflows/fork-build.yml`**（新文件，不参与官方合并，**不需要任何 secrets**）。

### 用法

GitHub → 你的 fork → Actions → 左侧 **"Fork Build (Windows + Android)"** → Run workflow：

| 输入 | 说明 |
| --- | --- |
| `ref` | 要构建的分支 / 标签 / commit；留空 = 触发时所在的分支 |
| `build` | `all`（默认）、`windows`、`android`；只跑一个可以省时间 |
| `windows_arch` | `x64`（默认）、`arm64` |
| `android_abi` | `universal`（默认，兼容所有机型）、`arm64`（体积小 4 倍） |
| `android_variant` | `release`（默认，体积小、需签名）、`debug`（构建快、体积大） |

跑完在 Artifacts 里下载：`readest-fork-windows-<arch>`、`readest-fork-android-<abi>`。两个 job 并行，耗时取较慢的那个。

### Windows 产物

| 文件 | 说明 |
| --- | --- |
| `Readest-fork-<版本>-<arch>-setup.exe` | NSIS 安装包 |
| `Readest-fork-<版本>-<arch>-portable.exe` | 单文件便携版，免安装 |

- **未签名**：构建时现场生成 `src-tauri/tauri.fork-unsigned.conf.json`（只含 `{"bundle":{"createUpdaterArtifacts":false}}`，由 `--config` 合并进主配置），所以不需要 `TAURI_SIGNING_PRIVATE_KEY`。代价是首次运行会有 SmartScreen 警告，点"仍要运行"即可。
- 便携版是**第二次构建**（同一个应用，只是 `NEXT_PUBLIC_PORTABLE_APP=true`）。它会覆盖掉安装包，所以工作流先把安装包拷出来、再构建便携版（上游 nightly.yml 里有同样的注释）。
- **更新检查已关**：源码层由 `APP_UPDATES_ENABLED` 关闭（见 §3.7），所有平台一律不出网。构建用的 `tauri.fork.conf.json` 另外把 `plugins.updater.endpoints` 覆盖为 `[]`（桌面路径的第二道防线；对安卓无效，别指望它）。

### Android 产物

`Readest-fork-<版本>-<universal|arm64>-<release|debug>.apk`，构建类型在 Actions 里用 `android_variant` 选：

- **release（默认）**：体积约等于官方包（官方 v0.12.8：arm64 84.7 MB / universal 310.8 MB）。它**必须签名**，用的是自己的永久 keystore，通过仓库 secrets 注入，变量名与官方 `release.yml` **完全一致**，所以以后想直接跑官方发布流程也能复用同一把钥匙：

  | Secret | 内容 |
  |---|---|
  | `ANDROID_KEY_BASE64` | `keytool -genkeypair` 产出的 `.jks` 做 **base64 编码后的那一行文本**（Secret 只能存文本，`.jks` 是二进制，工作流里再 `base64 -d` 还原成文件） |
  | `ANDROID_KEY_ALIAS` | 生成时的 `-alias`，例如 `fork` |
  | `ANDROID_KEY_PASSWORD` | 生成时的 `-storepass` 口令（仓库那段签名配置对 key 与 store 用同一个口令） |

  工作流把三者写成 `keystore.properties`（`keyAlias` / `password` / `storeFile`），仓库自带的 `app/build.gradle.kts` 会对 **release 与 debug 两种构建类型都套用**这个签名配置，所以两种包型可以互相覆盖安装。**这把钥匙要长期保留**：换了钥匙就无法升级已安装的包，只能卸载重装（卸载会清掉本地书库与配置）。未配置 secrets 时该步骤自动跳过，此时选 `release` 会因产出 `*-unsigned.apk`（装不上）而**明确报错**，不会静默给你一个废包。

- **debug**：构建快得多（Rust 只编 debug profile），但体积是 release 的数倍 —— `.so` 带完整调试符号，加上 `app/build.gradle.kts:73-76` 的 `keepDebugSymbols` 和 universal 的 4 份 `.so`，解压后能到 2 GB 量级。**只给自己设备装的话，把 `android_abi` 选 `arm64` 就立刻降到约 1/4。**

⚠️ **`src-tauri/gen/android` 里有被 git 跟踪的定制文件（15 个），`pnpm tauri android init` 之后必须跑 `git checkout .`**：

`app/build.gradle.kts`（`compileSdk = 36`、Sentry / webkit / appcompat 依赖、`rust` 插件接线）、`AndroidManifest.xml`、`MainActivity.kt`、图标与启动图资源、`values/themes.xml`，以及一个单测 `KeyLearnCaptureTest.kt` 都是**仓库自带**的。工作流里的顺序是官方那套：

```
rm -rf src-tauri/gen/android     # 清掉上次生成物
pnpm tauri android init          # 生成脚手架（此时上面这些被 CLI 模板覆盖）
pnpm tauri icon ../../data/icons/readest-book.png
git checkout .                   # ← 关键：把仓库自带的那些文件恢复回来
```

漏掉最后一步，Gradle 用的就是 CLI 模板，打出来的会是**另一个 App**（模板的 manifest / 入口 Activity / Gradle 配置），而不是这个项目。工作流里另加了一步自检（grep `missingDimensionStrategy("store")` 与 `usesCleartextTraffic`）来兜住这个坑。**已经踩过一次**，症状是：

```
Could not determine the dependencies of task ':app:compileUniversalDebugJavaWithJavac'.
> Could not resolve project :tauri-plugin-native-bridge.
   > However we cannot choose between the following variants of project :tauri-plugin-native-bridge:
       - fossDebugApiElements
       - googleplayDebugApiElements
```

原因：仓库本地插件 `src-tauri/plugins/tauri-plugin-native-bridge` 声明了 `store` 维度与 `foss` / `googleplay` 两个 flavor，只有仓库自带的 `app/build.gradle.kts` 里那句 `missingDimensionStrategy("store", storeFlavor)` 告诉 Gradle 消费哪一个（默认 `foss`）；模板文件没有这句，于是变体歧义。

### 时间

两者首次冷构建都在 40–60 分钟量级（以 Rust 编译为主），之后有 rust-cache 会快很多。本地构建 Windows 需要 Rust（msvc toolchain）+ VS 生成工具，Android 还要 Java 17 + Android SDK + NDK 28.2.13676358 —— 有 CI 就没必要在本地折腾。

---

## 6. 与官方同步（merge 提示）

```bash
git remote add upstream https://github.com/readest/readest.git
git fetch upstream
git merge upstream/main        # 在 fork 分支上
grep -rn ACCOUNTLESS_BUILD apps/readest-app/src   # 逐处复核
```

冲突面主要在 UI 组件（3.3 的 9 个文件）——这是本 fork 唯一的代价。所有 fork 逻辑都集中在中央开关 + 每处 1 行守卫，重定位成本很低。
