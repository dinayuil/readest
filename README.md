# Readest lite

[简体中文](README.md) | [English](README.en.md)

**使用自己的云存储同步书库，无需注册或登录 Readest 账号。**

Readest lite 是 [Readest](https://github.com/readest/readest) 的独立 fork，保留上游的
阅读、书库、标注和朗读能力，主要调整账号依赖、遥测和发布方式。本 fork 提供
Windows 与 Android 构建，与官方 Readest 分别发布和维护。

[下载最新版本](https://github.com/dinayuil/readest-lite/releases/latest) ·
[构建记录](https://github.com/dinayuil/readest-lite/actions/workflows/fork-build.yml) ·
[唯一进度记录](fork/status.md)

## 主要特点

- **免 Readest 账号同步**：可配置 WebDAV、S3 等第三方云存储，同步书库、书籍文件、
  阅读进度、高亮与笔记；第三方服务自身的凭据仍需正常配置。
- **简化账号入口**：隐藏官方账号、订阅和依赖官方账号的集成入口，减少无效的
  登录、升级跳转。
- **关闭 PostHog 使用遥测**：阻止 SDK 初始化和事件上报，隐藏遥测开关与同意弹窗。
  Sentry 崩溃上报仍保留，详见[实现说明](fork/requirements.md)。
- **关闭官方应用更新检查**：桌面、Android 和 nightly 检查均在源码层关闭，避免
  提示安装签名不同的官方包。新版本从本仓库 Releases 下载并手动安装。
- **翻译默认使用 Google**：过滤需要 Readest 登录的翻译服务；旧配置选择了不可用
  服务时，首次翻译即使用可用的回退服务。
- **Windows + Android 自动发布**：push 后构建两个平台；`lite` 分支两端都成功后，
  自动发布带安装包的 GitHub Release。

继续使用上游的多格式阅读、标注、字典、TTS、OPDS 和阅读布局等功能。上游完整功能
介绍见 [Readest 官方仓库](https://github.com/readest/readest)。

## 下载与安装

前往本 fork 的 [Releases](https://github.com/dinayuil/readest-lite/releases)：

| 平台 | 下载文件 | 用途 |
| --- | --- | --- |
| Windows | `Readest-lite-<版本>-x64-setup.exe` | 安装版 |
| Windows | `Readest-lite-<版本>-x64-portable.exe` | 便携版 |
| Android | `Readest-lite-<版本>-universal-release.apk` | 签名 APK，兼容多种架构 |

Release 标签使用 `v<上游版本>-lite.<构建编号>`，标题使用 `Readest lite`。早期发布的
文件可能仍以 `Readest-fork-` 开头；名称变更后的发布使用上表格式。

Windows 安装包未做代码签名，系统可能显示 SmartScreen 提示。Android 使用本 fork
自己的签名密钥，后续版本沿用该密钥；官方 APK 与本 fork 的 APK 不能互相覆盖安装。

应用改名保留现有包标识、URL scheme 和数据路径，以兼容已有 fork 数据。Windows
安装器同时用产品名识别安装目录和卸载项，因此改名后可能仍留有旧的 `Readest`
安装项。Android 沿用原 applicationId 和签名，可覆盖升级。本 fork 不承诺与官方版
并行安装及数据隔离。

## 同步范围与限制

在设置的集成页面配置自己的存储后，即可同步书库、书籍、阅读进度与标注。
**这不等于开放所有官方在线服务或订阅功能**：

- App 全局设置、阅读统计等官方账号数据，不因此获得第三方文件同步能力。
- 官方云存储、官方 AI/翻译代理等依赖账号的服务，不在免账号方案范围内。
- Google Drive / OneDrive 需要自行申请 OAuth 应用并配置客户端 ID；WebDAV / S3
  不需要这一步。
- 只在本仓库自动构建 Windows 和 Android；上游支持的其它平台并不代表本 fork
  已提供或验证相应安装包。

详细范围与开关见 [fork/requirements.md](fork/requirements.md)。

## 开发与维护

```bash
git clone --recurse-submodules https://github.com/dinayuil/readest-lite.git
cd readest-lite
pnpm install
pnpm -C apps/readest-app dev-web
```

原生构建所需工具链见 [CONTRIBUTING.md](CONTRIBUTING.md)；fork 的产物、签名和
工作流说明见 [fork/build.md](fork/build.md)。

本 fork 通过 merge 跟进官方发布标签。维护入口为根目录 [AGENTS.md](AGENTS.md)，
**所有进度、验证结果、待办和已知问题只记录在 [fork/status.md](fork/status.md)**，
本 README 仅介绍产品特点和使用方式。

- [需求与实现说明](fork/requirements.md)
- [构建说明](fork/build.md)
- [同步上游流程](fork/upstream-sync.md)
- [应用测试说明](apps/readest-app/docs/testing.md)

## 致谢与许可证

本项目基于 [Readest](https://github.com/readest/readest)，感谢 Readest、
[Foliate](https://github.com/johnfactotum/foliate) 及其贡献者。
Readest lite 是独立维护的 fork，官方站点和商店下载提供的是上游版本。

沿用仓库的 [GNU Affero General Public License v3.0](LICENSE)。原有版权声明和
第三方许可保留。
