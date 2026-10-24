# v4 RL API v2 对齐

## 目标与范围
对照本地 rankland-web 的实际 DTO、controller、service 和 proto，修复 v4 的比赛创建/更新并检查其余 RL 调用。保留用户已有修改，不创建分支，不连接生产服务。修复完成后用户要求仅提交本次会话改动。

## 分段计划
1. 契约清点与确定性复现 — complete
2. 修复字段映射及其他已证实的不一致，添加回归验证 — complete
3. 执行测试、检查差异并沉淀接口设计文档 — complete

## 验证策略
使用 Node 测试执行实际请求构造路径，以本地 rankland-web 契约为判定依据；对 HTTP 和数据库使用隔离替身。检查事件 protobuf 及错误响应，不运行常驻爬虫或实际服务写入。

## 已知环境
- package.json 已有 test 命令但指向的两个测试文件尚不存在，避免覆盖已有改动。
- 两个项目均有无关未提交修改，参考项目只读。

## 错误记录
- 初次较大批量读取发生输出截断，后续缩小范围读取。
- 两次辅助读取使用了错误工作目录/猜测文件名，均为只读失败；后续改为已核实路径。
- 初始 helper 回归测试：7 项中 4 项失败，准确复现字段透传、隐式 null、无效 title、时长溢出；新增 builder 测试在实现前也失败。
- 最终复查发现 Axios 响应中断的 ERR_BAD_RESPONSE 也需要重试；已补充存在 request、无 response 且无限 maxContentLength 条件及回归。

## 完成结果
- npm test：29/29 通过；业务文件语法及 git diff --check 通过。
- 五组请求通过参考仓库真实 DTO 校验；全部五处 RL 调用已审计。
- 设计文档：docs/v4-rankland-api-v2.md。
- 没有实际服务写入或分支创建；用户已有配置及临时文件保持原状。
- 为严格隔离已有 package.json 改动，本次测试入口独立为 test:v4；原有 test 命令改动留在工作区，不纳入提交。
