# Readest fork（分支 `lite`）

本仓库是 [`readest/readest`](https://github.com/readest/readest) 的 fork：

- `origin` = `dinayuil/readest`（本 fork）
- `upstream` = `readest/readest`（官方）
- 工作分支：`lite`；只跟官方**发布 tag**，不跟 `upstream/main`

## 进度入口（唯一）

**本 fork 的进度、待办、合并记录只看 [`fork/status.md`](fork/status.md)。**

不要再创建 `TODO.md`、`PROGRESS.md`、`NOTES.md`、`.workbuddy/` 之类的平行
记录；所有进度都更新到 `fork/status.md`。其它文档只放静态说明：

| 文档 | 内容 |
| --- | --- |
| [`fork/status.md`](fork/status.md) | **唯一进度记录**：当前基线、合并记录、验证结果、待办、已知取舍 |
| [`fork/requirements.md`](fork/requirements.md) | 这个 fork 的目标、`ACCOUNTLESS_BUILD` 开关、逐文件改动清单、能/不能同步的内容 |
| [`fork/build.md`](fork/build.md) | Windows + Android 客户端构建、产物、签名 secrets、Android 脚手架注意事项 |
| [`fork/upstream-sync.md`](fork/upstream-sync.md) | 拉取官方发布版、merge、冲突处理、子模块、CRLF/husky、CI 说明 |

`apps/readest-app/AGENTS.md` 里的应用开发规则仍然适用（测试、TypeScript、i18n、
设计系统、E-ink 等）；本文件只额外说明 fork 的进度入口和构建约束。

## 核心约定

1. **所有 fork 行为由一个开关控制**：`apps/readest-app/src/utils/access.ts` 的
   `ACCOUNTLESS_BUILD`。合并上游后逐处复核：

   ```bash
   grep -rn ACCOUNTLESS_BUILD apps/readest-app/src
   ```

2. **恢复官方行为**：把 `ACCOUNTLESS_BUILD` 改为 `false`，所有派生开关
   （云同步付费墙、更新检查、遥测）自动恢复。
3. **不要删除官方功能代码**：入口用守卫隐藏，保留页面/服务本身，减少上游合并
   冲突。
4. **合并上游**：只 merge 发布 tag，用
   [`fork/upstream-sync.md`](fork/upstream-sync.md) 的流程；冲突时优先官方实现，
   再把 fork 守卫加回去。合并记录追加到 `fork/status.md`。
5. **构建**：`.github/workflows/fork-build.yml` 在每次 push 后构建 Windows +
   Android；`lite` 分支两个构建都成功后会同时发布 GitHub Release。不要重新启用
   官方 nightly / release / 定时工作流，除非确有需要。

## 常用验证

```bash
pnpm install                                # 根目录，安装依赖与 husky 钩子
pnpm -C apps/readest-app exec tsc --noEmit
pnpm -C apps/readest-app format:check
pnpm -C apps/readest-app test
```

fork 契约测试（改到相关代码时必跑）：

```bash
pnpm -C apps/readest-app test -- \
  src/__tests__/utils/access-accountless.test.ts \
  src/__tests__/hooks/useTranslator.test.ts \
  src/__tests__/helpers/updater.test.ts \
  src/__tests__/utils/telemetry.test.ts \
  src/__tests__/components/tts/TTSPlayerSheet.test.tsx \
  src/__tests__/app/library/useLibraryRefresh.test.tsx \
  src/__tests__/app/library/useAbsOfflineDownload.test.tsx
```

## 本地环境备注

- Windows 上仓库已设 `core.autocrlf input`；若 `format:check` 报大量 CRLF 错误，
  按 [`fork/upstream-sync.md`](fork/upstream-sync.md) 第 6 节处理。
- 新 clone 后必须在根目录跑 `pnpm install`，否则 husky 的 pre-push 钩子不存在。
