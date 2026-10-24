# 契约核对记录

- v4 的创建/更新都通过 rankland-contest-http.js 构造 payload；push-rlef.js 也使用同一 helper，修改需考虑该调用方。
- rankland-web 的 docs/contest-api.md 明确 PATCH 为外层字段部分更新，省略字段不更新。
- v4 的 RL 网络调用包括 GET contest、POST contest、PATCH contest、GET event-stream、POST protobuf events。
- 开始时配置文件和 package.json 已修改，多个临时脚本未跟踪；不纳入本次修改范围。
- 当前 helper 已展平 contest，但透传未知 SRK 字段；省略 frozenDuration/banner/refLinks 会强制补 null，不符合 PATCH 省略字段不更新语义。
- 服务端 title 要求非空 fallback 且所有语言值为字符串；duration 换算整秒后最大 0xffffffff；uk 长度 3..64，name 长度 3..255。
- 创建必传 problems/users/markers/series，其中除 users 外可为 null；srkFileID 仅 PATCH，redirectUK 两者均可。
- 五处 RL 请求路径、HTTP methods、认证和 producer headers、proto 定义均对齐。append permanent errors 应停止，网络/5xx 原样重试；任意 HTTP 404 不代表业务码 ContestNotFound。
- proto uint32 序列化会对超界值截断，需要在编码前验证 solutionId/eventId/streamRevision。
- Axios 0.27.2 HTTP adapter 在响应中途断开时产生 ERR_BAD_RESPONSE；区分带 request、无 response 且 maxContentLength=-1 的网络中断，与有限大小限制/本地解析错误。
- 最终测试：29 项离线回归通过，五组真实 DTO 校验通过；完整审计结论已沉淀到 docs/v4-rankland-api-v2.md。
