# 单机重跑结构图编译评测

这组文件用于复验 HumanBoard 私仓的结构图编译改动。两侧各包含编译器、缺省值、文字测量和 Scene 类型定义四个源文件。固定输入由脚本生成。运行只在这个子目录安装 Zod，画板演练服务无需这个依赖。

在公开仓库根目录执行以下命令。原始实测使用 Bun 1.3.13。重跑还需要 Node.js、npm 和 POSIX shell。首次安装需联网下载锁定版本的 Zod。

```sh
cd docs/evals/replay
npm ci --ignore-scripts --no-audit --no-fund
./run.sh > replay.json
```

脚本先比较两侧的完整 Scene 和无效输入报错，再交替计时。每种负载每侧先预热两轮，再记录十轮。计时仅覆盖 `compileDiagram()`，不含模块加载、输入生成、哈希和浏览器渲染。最后核对已发布的源文件、固定输入和输出 SHA-256。任一核对失败时返回非零状态。

在 [原始记录](../artifacts/diagram-layout.json) 与新生成的 `replay.json` 中，`measurements[].samples_ms` 保存每轮耗时，`median_ms` 保存中位数。输入和输出可跨次核对，耗时会随机器与负载变化。
