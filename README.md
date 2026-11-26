# HumanBoard Open

一张能分支、提交和合并的中文画板。人可以在浏览器里挪动卡片，Agent 可以通过 HTTP 或 MCP 从同一份快照另开分支。两边改动撞在一起时，画板会列出原值和双方的新值，留给审阅者选择。

[交互式作品页](docs/index.html) · [中文短片](docs/media/promo.mp4) · [结构图排版实验与原始数据](docs/evals/refactor-1126-report.md)

![本机实际运行的卡片画板，右侧同时显示人的改稿、Agent 提案和双亲合并版本。](docs/media/board.png)

## 先做一次交接

使用 Node.js 24。应用使用 Node 内置 SQLite，在仓库根目录即可启动。

```sh
npm start
```

打开 <http://127.0.0.1:4317>。初稿里有「记录现场」「分支提案」「一起审阅」三张卡片。在主线上编辑并提交一版，再开一个终端，从同一目录运行演练。

```sh
npm run demo
```

演练会从此时的主线头创建新的 `agent-…` 分支，加入一张建议卡，打印可在浏览器中打开的地址。此时主线仍指向原来的版本。可以回主线调整已有卡片并提交，随后选择提案分支预览合并。两份修改分别触及不同内容时可以一起保留。想观察冲突，可以从同一版本分支，在两边给同一张卡片写不同的标题，再预览合并。

演练逻辑写在 [scripts/demo.mjs](scripts/demo.mjs)。它使用确定性编辑步骤，分支标识每次分配。整条路径可以离线运行。

## 让 Agent 接手一张画板

| 通道 | 从哪里开始 | 写入时带什么 |
| --- | --- | --- |
| 浏览器 | 在画布选择卡片，编辑或移动后提交 | 当前分支和开始编辑时的版本 |
| HTTP | `GET /api/state?branch=main` | 提交带 `base`，合并带两个分支头 |
| MCP stdio | 在客户端启动 `node /绝对路径/HumanBoard-Open/src/mcp.mjs` | 工具直接调用同一份版本存储 |

MCP 客户端配置示例。把参数换成自己的绝对路径。HTTP 服务与 MCP 进程可独立启动，默认访问仓库内同一数据库。

```json
{
  "mcpServers": {
    "humanboard": {
      "command": "node",
      "args": ["/绝对路径/HumanBoard-Open/src/mcp.mjs"]
    }
  }
}
```

可以交给 Agent 这项任务：

> 读取 main 的 head，从它创建 proposal 分支。在新分支把「记录现场」的说明补充为一句可观察的问题，保留其他卡片，提交后给我看与原版的差异。合入主线前等我审阅。

工具顺序是 `board_state`、`board_branch`、`board_commit`、`board_diff`。需要读取历史快照时用 `board_version`，审阅及确认合并时调用 `board_merge`。协议协商由 stdio 入口处理。工具调用和页面操作以本机使用者的权限执行，`author` 用来标记编辑来源。

## HTTP 契约

请求正文使用 `application/json`。下表中的大写名称指此前读取的实际值。提交传入完整卡片数组，漏掉已有卡片即表示删除该卡片。

| 方法和路径 | 请求内容或查询 | 结果 |
| --- | --- | --- |
| GET /api/state | `?branch=main` | 分支头、当前卡片、分支列表、版本历史 |
| GET /api/version | `?id=VERSION` | 含父版本和卡片的快照 |
| GET /api/diff | `?from=BASE&to=HEAD` | 按卡片 ID 列出新增、删除和字段变化 |
| POST /api/branch | `{"name":"proposal","from":"BASE"}` | 新分支指向 BASE |
| POST /api/commit | `branch, base, cards, message, author` | 新 head，或内容相同的原 head |
| POST /api/merge | `target, source, targetHead, sourceHead, preview, resolutions?` | 预览返回共同祖先、冲突和相对目标的变化，确认后返回 head |

先传 `preview: true` 读取冲突，再带着原来的双端 head 和 `preview: false` 确认。`resolutions` 的一项形如 `{"id":"question","field":"title","use":"source"}`。同卡删除对编辑等整卡冲突使用 `$card`。分支已前移时返回 HTTP 409 与 `STALE_HEAD`，客户端可重新读取并审阅，或者把自己的草稿提交到从旧版创建的新分支。

## 版本怎样落盘

- 每个版本保存完整卡片快照和父版本 ID。独立修改分叉后再合入会生成双亲版本。目标端停在共同祖先时可以直接快进。
- 服务在 SQLite 写事务内核对版本头、写入版本并移动分支指针。读取某一版本不会移动分支。
- 合并按稳定卡片 ID 和字段比较共同祖先、目标与提案。双方把同一字段改成同一个值时也能自动收敛。出现多个最近共同祖先时会明确报告歧义。
- 默认数据目录是 `.humanboard-open/`。使用 `HUMANBOARD_DIR` 可指定独立目录，浏览器服务和 MCP 需要指向同一位置才能共享画板。通过 `PORT` 可更换本机 HTTP 端口。

## 工程与复核

| 目录 | 内容 |
| --- | --- |
| [src](src/) | 卡片校验、三方合并、SQLite 事务、HTTP 与 stdio MCP |
| [public](public/) | 浏览器编辑器与版本审阅界面 |
| [test](test/) | 可在临时数据目录运行的回归检查 |
| [docs](docs/) | 可直接托管在 GitHub Pages 的中文静态站 |
| [docs/evals](docs/evals/) | 原 TypeScript 项目抽出的结构图排版实验、公开源码快照与原始记录 |

```sh
npm test
```

Open 版专注单机卡片协作。原项目的自由画布、笔迹、资产、模型配置与部署服务保留在原仓。这里另附的排版实验测量原项目的 Diagram → Scene 编译器，卡片演练服务使用自己的场景模型。实验可以独立复核，详见 [对照报告](docs/evals/refactor-1126-report.md)。

代码采用 [MIT 许可证](LICENSE)。
