# Fork TODO — 无账号构建（ACCOUNTLESS_BUILD）

本文件只放**待办**。这个 fork 做了什么、怎么构建、怎么和官方同步，见 `FORK.md`。

两个文件都只属于这个 fork（官方仓库没有它们），所以官方更新永远不会在这里产生冲突。

---

## 1. 阅读统计走文件同步（主要待办）

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

## 2. 其它

- [ ] **把存量的 `translationProvider` 迁移掉（仅影响观感）**：默认值改动只影响新装；老配置里仍是 `deepl`。翻译行为与两个选择器的显示都已经通过同步解析修正，但设置文件里存的值仍写着 `deepl`。彻底的做法是加一条 fork 迁移（`appService.runMigrations` 里 `< 20260919` 的版本闸门 + 一个小函数），把不能在本构建运行的值改写为首个可用者。优先级低。
- ✅ **更新检查已关（含安卓）**：Windows 侧原本靠构建配置把 `plugins.updater.endpoints` 覆盖为 `[]` 了，但**安卓根本不看那份配置** —— 它自己 `fetch` 写死的 `https://download.readest.com/releases/latest.json`，所以 fork APK 照样弹官方更新。现在在源码层用 `APP_UPDATES_ENABLED`（由 `ACCOUNTLESS_BUILD` 派生）把 `checkForAppUpdates()`（含安卓分支与 nightly 通道）和 `checkAppReleaseNotes()` 一并早返回，零出网 —— 详见 `FORK.md` §3.7，那里也记了"官方包本来就装不上"（签名不一致 → `INSTALL_FAILED_UPDATE_INCOMPATIBLE`）。
  - [ ] 残留 1 已降级：`helpers/updater.ts` 现在连手动检查都直接返回 `false`，"关于"窗口点"检查更新"显示"已是最新"而不再是报错（原先那条要动 Rust 才能修）。`hasUpdater` 仍为 true，所以那颗按钮还在；想把它和设置里的自动更新 / nightly 开关一起隐藏，再去改 `AboutWindow.tsx` 的更新状态块与 `ControlPanel.tsx`。**改组件时记得补 `@/utils/access` 的 mock** —— §3.6 移除遥测那次就是这样踩到的（access 在模块作用域会被求值）。
  - [ ] 残留 2（提醒）：构建配置里的 `endpoints: []` 现在只剩防御作用，可以留着也可以删；但**不能**因为"构建配置已经处理了更新"就把源码开关去掉 —— 安卓路径不认那份配置。

- ✅ **遥测已移除**：`.env` 里虽然仍带着官方 PostHog 的默认 key，但客户端**不再初始化 PostHog**（`PHContext` 的守卫），上报入口、设置里的开关和命令面板动作都一并撤掉 —— 详见 `FORK.md` §3.6。
- [ ] **WebDAV / S3 在网页版受浏览器跨域限制**：需要云存储侧返回 `Access-Control-Allow-*`（Nextcloud、Aliso 等可配置；S3/R2 需配 bucket CORS）。App（桌面/安卓）没有这个限制。若长期只在网页版用，可以考虑给 WebDAV 加一个同源代理。
- [ ] **Google Drive / OneDrive 需要自己申请 OAuth 应用**：代码里烘焙的 client id 绑定了官方回调地址，自建版本要用 `NEXT_PUBLIC_GOOGLE_CLIENT_ID` / `NEXT_PUBLIC_MICROSOFT_CLIENT_ID` 换成自己申请的（桌面端还要同步改 `src-tauri/tauri.conf.json` 里的反向 DNS 回调 scheme）。**WebDAV / S3 不需要申请任何东西。**
- [ ] 安卓端 iCloud 不可用（仅 Apple 平台）。
- [ ] 若想让"已登录用户"仍看到官方账号入口（本 fork 目前对所有人隐藏），把相应守卫从 `ACCOUNTLESS_BUILD` 改为 `ACCOUNTLESS_BUILD && !user` 即可。
