# Fork 客户端构建（Windows + Android）

> 进度与待办见 [`status.md`](status.md)。本文件只说明构建方式。

## 1. 用哪个工作流

**`.github/workflows/fork-build.yml`**（`Fork Build (Windows + Android)`）。

- **每次 push 自动触发**：Windows 与 Android 两个 job 并行构建。
- 同时保留 `workflow_dispatch`，用于手动补跑或临时改架构/ABI/构建类型。
- 构建成功后，在 Actions → 该次运行 → Artifacts 下载：
  - `readest-fork-windows-<arch>`
  - `readest-fork-android-<abi>`
- 如果是 `lite` 分支的 push，且两个 job 都成功，还会自动创建 GitHub Release，
  见下方“自动发布”。

为什么需要自己的工作流：官方 `release.yml` / `nightly.yml` 的签名与上传步骤依赖
仓库 secrets（Android keystore、更新签名、R2 凭据），fork 里没有这些，直接跑会在
最后一步失败；而且 `tauri.conf.json` 开着 `createUpdaterArtifacts: true`，没有签名
密钥连 Windows 构建都过不去。这个工作流是 fork 新增文件，不参与官方合并，**不需要
任何 secrets 也能跑 Windows**。

### 自动发布（GitHub Release）

`release` job 在两个构建 job 都成功后运行：

- 只对 **`lite` 分支的 push** 生效；手动 `workflow_dispatch` 只留 Artifacts，
  不自动发布（手动构建可能是旧 ref、单平台或 debug 包）。
- tag：`v<package.json 版本>-fork.<run_number>`，例如
  `v0.12.20-fork.518`；title 带版本与 build 号。
- Assets：Windows 的 `setup.exe` + `portable.exe`，Android 的 `.apk`，全部来自
  两个 job 上传的 Artifacts。
- 重跑同一次 workflow 时 tag 不变，会更新已有 release（`gh release upload
  --clobber`），不会因 tag 已存在而失败。
- 使用 GitHub 自动提供的 `GITHUB_TOKEN`（job 级 `contents: write`），不需要额外
  PAT；由 `GITHUB_TOKEN` 创建的 release 不会反过来触发 `release.yml` 等其它
  工作流。

## 2. 手动运行参数

| 输入 | 说明 |
| --- | --- |
| `ref` | 要构建的分支 / 标签 / commit；留空 = 触发时所在的分支 |
| `build` | `all`（默认）、`windows`、`android`；只跑一个可以省时间 |
| `windows_arch` | `x64`（默认）、`arm64` |
| `android_abi` | `universal`（默认，兼容所有机型）、`arm64`（体积小 4 倍） |
| `android_variant` | `release`（默认，体积小、需签名）、`debug`（构建快、体积大） |

`push` 触发时上述输入为空，工作流内部已补默认值：`all` / `x64` /
`universal` / `release`。同一 ref 的新 push 会取消仍在跑的旧构建
（`concurrency.cancel-in-progress: true`）。

## 3. Windows 产物

| 文件 | 说明 |
| --- | --- |
| `Readest-fork-<版本>-<arch>-setup.exe` | NSIS 安装包 |
| `Readest-fork-<版本>-<arch>-portable.exe` | 单文件便携版，免安装 |

- **未签名**：构建时现场生成 `src-tauri/tauri.fork-unsigned.conf.json`（只含
  `{"bundle":{"createUpdaterArtifacts":false}}`，由 `--config` 合并进主配置），
  所以不需要 `TAURI_SIGNING_PRIVATE_KEY`。代价是首次运行有 SmartScreen 警告，
  点“仍要运行”即可。
- 便携版是**第二次构建**（同一个应用，只是 `NEXT_PUBLIC_PORTABLE_APP=true`）。
  它会覆盖掉安装包，所以工作流先把安装包拷出来、再构建便携版。
- **更新检查已关**：源码层由 `APP_UPDATES_ENABLED` 关闭；构建用的
  `tauri.fork.conf.json` 另外把 `plugins.updater.endpoints` 覆盖为 `[]`
  （桌面侧第二道防线；对 Android 无效，别指望它）。

## 4. Android 产物

`Readest-fork-<版本>-<universal|arm64>-<release|debug>.apk`。

- **release（默认）**：体积约等于官方包。它**必须签名**，用的是 fork 自己的
  永久 keystore，通过仓库 secrets 注入，变量名与官方 `release.yml` 完全一致：

  | Secret | 内容 |
  | --- | --- |
  | `ANDROID_KEY_BASE64` | `keytool -genkeypair` 产出的 `.jks` 做 **base64 编码后的那一行文本**（Secret 只能存文本，工作流里再 `base64 -d` 还原成文件） |
  | `ANDROID_KEY_ALIAS` | 生成时的 `-alias`，例如 `fork` |
  | `ANDROID_KEY_PASSWORD` | 生成时的 `-storepass` 口令（仓库那段签名配置对 key 与 store 用同一个口令） |

  工作流把三者写成 `keystore.properties`（`keyAlias` / `password` /
  `storeFile`），仓库自带的 `app/build.gradle.kts` 会对 release 与 debug 两种
  构建类型都套用这个签名配置，所以两种包型可以互相覆盖安装。
  **这把钥匙要长期保留**：换了钥匙就无法升级已安装的包，只能卸载重装（卸载会
  清掉本地书库与配置）。未配置 secrets 时该步骤自动跳过，此时选 `release` 会因
  产出 `*-unsigned.apk`（装不上）而**明确报错**，不会静默给你一个废包。

- **debug**：构建快得多（Rust 只编 debug profile），但体积是 release 的数倍。
  只给自己设备装的话，把 `android_abi` 选 `arm64` 可立刻降到约 1/4。

### ⚠️ `src-tauri/gen/android` 的定制文件

`src-tauri/gen/android` 里有被 git 跟踪的定制文件（15 个）。`pnpm tauri android init`
会覆盖它们，**之后必须跑 `git checkout .`**：

```
rm -rf src-tauri/gen/android     # 清掉上次生成物
pnpm tauri android init          # 生成脚手架（此时被 CLI 模板覆盖）
pnpm tauri icon ../../data/icons/readest-book.png
git checkout .                   # ← 关键：恢复仓库自带的定制文件
```

涉及的定制文件包括 `app/build.gradle.kts`（`compileSdk = 36`、Sentry / webkit /
appcompat 依赖、`rust` 插件接线）、`AndroidManifest.xml`、`MainActivity.kt`、
图标与启动图资源、`values/themes.xml`，以及单测 `KeyLearnCaptureTest.kt`。

漏掉最后一步，Gradle 用的就是 CLI 模板，打出来的会是**另一个 App**。工作流里
另加了自检（grep `missingDimensionStrategy("store")` 与 `usesCleartextTraffic`）
兜底。踩过的症状：

```
Could not determine the dependencies of task ':app:compileUniversalDebugJavaWithJavac'.
> Could not resolve project :tauri-plugin-native-bridge.
   > However we cannot choose between the following variants ...
```

原因是本地插件声明了 `store` 维度与 `foss` / `googleplay` 两个 flavor，只有仓库
自带的 `app/build.gradle.kts` 里有 `missingDimensionStrategy("store", storeFlavor)`
告诉 Gradle 消费哪一个（默认 `foss`）；模板没有这句。

## 5. 时间

Windows 与 Android 首次冷构建都在 40–60 分钟量级（Rust 编译为主），之后有
`rust-cache` 会快很多。本地构建 Windows 需要 Rust（msvc toolchain）+ VS 生成工具；
Android 还要 Java 17 + Android SDK + NDK 28.2.13676358。有 CI 就没必要在本地折腾。

## 6. 其它自动构建

为减少 fork 里必然失败的定时任务，以下工作流的 `schedule` 触发已移除（仍可手动
运行）：`android-e2e.yml`、`codeql.yml`、`nightly.yml`、`nix-update-inputs.yml`、
`scorecard.yml`。日常只保留 `fork-build.yml` 的 push 构建。
