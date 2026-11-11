# 与官方同步

> 当前基线、合并记录与验证结果只看 [`status.md`](status.md)。本文件是可重复
> 执行的步骤，不记录某一次合并的进度。

## 1. 一次性配置

```bash
git remote add upstream git@github.com:readest/readest.git
# 或者：git remote add upstream https://github.com/readest/readest.git
git remote -v
# origin   = 你的 fork（dinayuil/readest）
# upstream = 官方（readest/readest）
```

## 2. 找到最新发布版并合并

不要合 `upstream/main`（里面可能有未发版提交）；本 fork 只跟官方发布 tag。

```bash
git fetch upstream --tags            # 只下载，不动工作区
git tag --sort=-v:refname | head     # 看最新 tag，官方带 v 前缀
git log --oneline -1 v0.12.20        # 确认 tag 指向的提交
git log --oneline lite..v0.12.20     # 这段区间就是官方新加的提交
git diff --stat lite..v0.12.20 -- apps/readest-app/src   # 冲突面预览
git merge v0.12.20                   # 在 lite 分支上合并
```

**用 merge，不要 rebase**：本 fork 的历史里已经有官方 merge 提交，rebase 会重写
fork 提交并制造重复冲突。

合并前确认工作区干净（`git status --porcelain` 无输出）。如果有未提交修改，先
提交或自行处理，不要直接 merge。

## 3. 解决冲突的原则

1. **优先保留官方实现**，再把 fork 的 1 行守卫加回去。
2. 所有 fork 逻辑都挂在 `ACCOUNTLESS_BUILD` 这一个词上，合并后 grep 一遍不会漏：

   ```bash
   grep -rn ACCOUNTLESS_BUILD apps/readest-app/src
   ```

3. 冲突面主要在 UI 组件和翻译/遥测相关文件；新增文件（`fork-build.yml`、
   `accountless.ts`、fork 测试）通常不会冲突。
4. 合并完成后确认没有残留标记：

   ```bash
   git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- apps/readest-app/src
   ```

5. 如果官方删除了某个 fork 改过的文件（例如只补过 mock 的测试），接受删除，
   不要为了保留 fork 差异而把文件复活。

## 4. 合并后必做

```bash
git submodule update --init --recursive   # 官方可能 bump foliate-js 等子模块
pnpm install                              # 根目录；顺带装 husky 钩子
```

官方版本会顺带 bump `packages/foliate-js`；merge 只改索引里的指针，**不会**自动
更新磁盘上那份。没跑第一条就构建，用的是旧 foliate-js，现象会很迷惑。

然后跑验证：

```bash
pnpm -C apps/readest-app exec tsc --noEmit
pnpm -C apps/readest-app format:check
pnpm -C apps/readest-app test
```

fork 的契约测试至少要看这些：

```bash
pnpm -C apps/readest-app test -- \
  src/__tests__/utils/access-accountless.test.ts \
  src/__tests__/hooks/useTranslator.test.ts \
  src/__tests__/helpers/updater.test.ts \
  src/__tests__/utils/telemetry.test.ts \
  src/__tests__/components/tts/TTSPlayerSheet.test.tsx \
  src/__tests__/app/library/useLibraryRefresh.test.tsx
```

确认版本号已变成新版本：

```bash
grep '"version"' apps/readest-app/package.json
```

## 5. 判断“是否真的合上了”

**没报冲突 ≠ 没合上。** merge 安静成功是正常的（fork 改动集中在少数文件，官方
通常不动它们）。判断依据：

```bash
git log --oneline lite..v0.12.20      # 应为空
grep '"version"' apps/readest-app/package.json   # 应是新版本
git log --oneline -1                  # 应能看到 Merge tag 'vX.Y.Z' into lite
```

## 6. Windows 换行符与 husky（本机已处理）

`git push` 时本地跑的 `format:check + lint + test` 来自仓库跟踪的
`.husky/pre-push`，与 GitHub Actions 无关。钩子靠 husky 把 `core.hooksPath` 设为
`.husky/_`，由根 `package.json` 的 `prepare: "husky"` 在 `pnpm install` 时执行。
新 clone 没跑过根目录 `pnpm install`（或用了 `--ignore-scripts`）就不会有钩子。

Windows 上 `format:check` 可能被 CRLF 全量打回（两千多个错误，每个文件整段
diff）。根因是 Git for Windows 在系统级写了 `core.autocrlf = true`，checkout 把
LF 转成了 CRLF，而 `biome.json` 写死 `lineEnding: "lf"`。判定与修复：

```bash
git config --show-origin --get core.autocrlf   # 定位哪一层设成了 true
git ls-files --eol | grep 'w/crlf'             # 看工作区哪些文件是 CRLF

git config core.autocrlf input                 # 只改本仓库
biome format --write .                         # 把工作区统一回 LF（等同 pnpm format）
git add --renormalize .                        # 刷新索引 stat 缓存
```

注意：改过 `core.autocrlf` 后 `git status` 会假报大量文件被改，`git diff` 才是
准的；`--renormalize` 只刷新缓存，blob 哈希不变。转换后不需要提交。

## 7. GitHub Actions 与推送

- 本 fork 的日常构建由 `.github/workflows/fork-build.yml` 负责：**每次 push**
  构建 Windows + Android；同一 ref 的新 push 会取消旧构建。`lite` 分支两个构建
  都成功后会发布 GitHub Release（tag 形如 `v0.12.20-fork.<run_number>`）。
- 官方工作流里带 `push` 的多数限定 `branches: [main]`，`pull-request.yml` 也只
  接受目标为 `main` 的 PR。推 `lite` 不会触发它们，这是预期行为。
- 已移除 `android-e2e` / `codeql` / `nightly` / `nix-update-inputs` / `scorecard`
  的定时触发，避免每天跑必然失败的官方任务；需要时手动运行。
- 想跑官方 PR checks，需要从该分支开一个 **base = main** 的 PR（同仓库 PR 不需要
  审批）。
