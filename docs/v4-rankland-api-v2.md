# v4 的 RankLand API v2 适配

2026-10-24 对照本地 `algoux/rankland-web`（HEAD `33d2ade`）完成核对。依据为 `src/common/modules/contest/contest.dto.ts`、`contest-metadata.ts`，服务端 `contest.controller.ts`、`contest.service.ts`、`contest-event-stream.service.ts`、`contest-event-codec.ts`，以及 `docs/contest-producer-consumer-guide.md` 和共享 proto。上述参考实现文件核对时没有未提交修改。

## 比赛写入

`v4.js` 从 OJ 数据库生成比赛元信息、题目和用户，与 `--srk-base` 配置合并，再由 `rankland-contest-http.js` 转成 API v2 请求。输入仍采用 SRK 风格的嵌套 `contest`，HTTP 请求将以下字段放在顶层：

| SRK 输入 | HTTP 字段与规则 |
| --- | --- |
| `contest.title` | `title`：字符串转成 `{ fallback: text }`；对象必须有非空 fallback，所有语言值必须是字符串 |
| `contest.startAt` | `startAt`：带时区的时间字符串，v4 由比赛开始时间生成 |
| `contest.duration` / `contest.frozenDuration` | 同名顶层字段；接受 s/min/h/d，转为 `[seconds, 's']`；整秒且范围为 0..4294967295 |
| `contest.banner` / `contest.refLinks` | 同名顶层字段；保留显式 null |
| `uk` / `name` | 创建时均为顶层；PATCH 的 uk 只放 URL；uk 长度 3..64，name 长度 3..255，按 Unicode 字符计数 |
| `problems` / `users` / `markers` / `series` | 顶层集合字段；创建时缺省补 `[]`；PATCH 未提供则省略 |
| `sorter` / `contributors` | 顶层配置，未提供则省略 |
| `redirectUK` | 创建和更新均可显式配置或清为 null |
| `srkFileID` | 只允许在 PATCH 中发送；创建时忽略，需要创建后另行绑定该比赛名下的文件 |

两个入口分别为 `buildRanklandContestCreatePayload` 和 `buildRanklandContestUpdatePayload`。只选取已声明的 API 字段；不会发送 SRK 的 `version`、`type`、`rows`、`solutions`、`updatedAt` 等额外内容，也不发送嵌套 `contest`。

PATCH 按外层字段整体替换。省略字段或 undefined 表示保留服务端现值；显式 null 表示清空可空字段；数组 `[]` 表示空集合。过去 helper 自动把缺少的 banner/refLinks/frozenDuration 补成 null，导致同步时意外清空；现在只处理明确提供的值。`problems`、`markers`、`series` 的显式 null 在创建和更新中均保留；`users` 仍应使用数组。

v4 每次启动仍同步 OJ 的题目和用户全集，`users` 更新会替换服务器集合。现有用户的 avatar/photo/teamMembers/markers/banned/broadcasterToken 在合并时保留，显式额外用户配置可以覆盖。默认 `srk-base.json` 中明确配置的 markers/series/sorter 等仍会发送并覆盖服务器对应字段。

共享 helper 也供 `push-rlef.js` 使用；已验证其创建及差异更新行为，省略元信息时同样保留已有值，显式 null 仍能清空。

## 调用清单

所有路径相对于 `/api/v2`，均携带 `x-token`。GET 与比赛写入请求接受 JSON `{ success, code, data }` envelope。

| 方法与路径 | 用途与约定 | 核对结果 |
| --- | --- | --- |
| GET `/contests/:uk` | 读取完整比赛及管理用户字段 | 路径/响应匹配；仅业务码 100001（兼容数字字符串）或旧符号名 CONTEST_NOT_FOUND 才进入创建流程；普通 404 不触发创建 |
| POST `/contests` | 创建比赛 | 使用创建字段集合，补齐必传集合，排除 srkFileID |
| PATCH `/contests/:uk` | 更新比赛 | 使用部分更新字段集合，省略 uk 和未提供字段 |
| GET `/contests/:uk/event-stream` | 获取 lastEventId、streamRevision、producerId | 路径/字段匹配；检查 uint32 范围，revision 必须大于零 |
| POST `/contests/:uk/events` | 推送事件 | `Content-Type: application/protobuf`、`Accept: application/json`、`x-producer-id`；body 为 BatchProducerEvent `{ streamRevision, events }` |

所有 uk 路径参数均用 `encodeURIComponent` 编码。本地 common/producer proto 与参考仓库一致；提交、判题进度、结果确定和结果变更四种事件的 payload 与服务端解析一致。进度事件可省略 time。服务端批上限 1000；v4 当前 `GRAB_LIMIT=1`，失败时暂停抓取，不会累积超过上限。

## 事件确认和重试

- 编码前验证 solutionId/eventId/streamRevision 的 uint32 范围，防止 protobuf 将超界值静默截断。无效 wire 值会使脚本停止，避免推进本地游标。
- 暂存待确认 batch 的原始 protobuf 字节、revision 和 OJ 游标。网络超时/断开、HTTP 408/429/5xx 重试原请求，成功确认前不抓新事件、不持久化新游标。
- 业务错误 100001..100007，以及参数/认证错误必须停止；其他非暂时性请求错误也停止。即使代理将这些业务错误包装成 5xx，也不会重试。由操作者修正 producer、事件或游标后重新启动。
- JSON envelope 要求 success 为 boolean；失败的 `X-RL-Resp-*` header 也能解析，数字字符串错误码统一为数字，msg/meta 进行 URI 解码。附加错误 metadata 仅用于诊断，服务端不一定提供。
- append 确认要求 revision 与本批一致、lastEventId 至少覆盖本批尾 ID、expectedNextEventId 等于 lastEventId+1。通过后才保存本地 OJ 和 RL 游标；重复批的确认同样接受。
- 启动时发现服务端新 revision 且 lastEventId 为零，清理旧缓存并重放 OJ 事件。运行中的 revision 冲突会退出，不会自动调用 reset 或释放 producer 锁。

## 验证

运行 `npm run test:v4`。测试隔离真实配置、MySQL 和网络，通过真实 Axios adapter 捕获请求，并解码实际 protobuf 字节；覆盖字段映射、PATCH 省略/清空、用户元信息、长度边界、错误码、事件与确认、主循环退出和原字节重试。`rankland-config.test.js` 使用注入配置 loader 验证 v2 配置选择，不读取认证信息。

另已使用参考仓库安装的 TypeScript、class-transformer 和 class-validator 加载真实 CreateContestReqDTO/UpdateContestReqDTO，验证默认创建、最小创建、可空集合创建、完整更新及部分更新五组请求全部通过。该检查为本次离线验证，常规测试不依赖另一个仓库的绝对路径。未连接真实数据库或 RL 服务，未进行生产写入。
