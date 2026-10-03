# 宠物救助故事创作台

React 创作台 + Express/SQLite 服务端，管理动物档案、救助时间线、叙事角色，
严格区分**内部记录**与**公开稿**，异步任务生成脱敏预览与导出包。

## 运行

```bash
npm install
npm run build     # esbuild 打包 React 前端 → public/bundle.js
npm start         # http://localhost:3000
npm test          # 9 项验收测试（node:test）
```

## 架构

```
server/db.js        SQLite 模式：内部表(animals/timeline/characters/media/private_notes)
                    与公开表(public_fragments/approvals)物理分离
server/sanitize.js  三层组合脱敏策略
server/services.js  领域逻辑：乐观锁、状态联动撤回、幂等任务、许可撤销、下载授权
server/queue.js     异步 worker：运行时二次校验，导出包组装
server/index.js     REST API + 静态前端
src/App.jsx         React 单页：档案/时间线/角色/媒体/公开稿/任务/人工复核
```

## 脱敏：组合策略（不是二选一）

1. **结构白名单**：只有登记字段可生成公开片段（`rescuer_phone`、`rescue_address`、
   `real_name` 等永远不进公开稿，违规生成会被拦截并记审计）。
2. **文本检测**：对白名单字段的*内容*做正则扫描（手机号/固话/身份证/邮箱/详细地址/社交账号），
   覆盖**所有文本面**——页面正文、字幕、旁白脚本、导出包附带清单，命中即占位脱敏并转人工。
3. **人工复核**：机器无法可靠判断的模态强制入队——
   - `image_faces` 照片/视频中的人脸
   - `audio_voice` 可辨识人声（声纹）
   - `photo_background` / `video_background` 背景中的门牌、车牌、路牌、地标、室内陈设
4. **元数据剥离**：导出时剥离 EXIF 中的 GPS、设备序列号、机主姓名等。

## 关键一致性设计

- **乐观锁**：`animals.version`，两人同时改状态，后到者收 409。
- **状态联动撤回**（事务内）：领养完成 → 已批准招领片 `withdrawn` + 排队/进行中的
  发布导出任务 `cancelled` + 相关下载授权 `revoked`。旧任务不会带病完成；
  导出 worker 运行时还会二次校验快照（许可撤销/片段撤回 → 排除并记 `exclusions`）。
- **幂等投稿**：`tasks.idempotency_key UNIQUE`，重复投稿返回已有任务。
- **私密备注**：`private_notes` 结构上不被任何公开/导出路径查询；
  导出快照在任务创建时生成，排队期间补入的备注天然不可达。
- **来源与批准依据**：`/api/animals/:id/public` 每个片段带
  `source{type,id,field}` 与 `approval{approver,basis,at}`。
- **下载授权**：token 可撤销（410）。撤销仅阻断新下载——
  **不声称已删除外部下载者持有的副本**，API 响应中如实声明。

## 验收场景（test/acceptance.test.js）

| # | 场景 | 机制 |
|---|------|------|
| 1 | 两人同时改动物状态 | 乐观锁，后到者 409 |
| 2 | 照片被撤销许可 | 发布任务取消；导出排除该媒体并记排除原因 |
| 3 | 导出排队中补入私密备注 | 创建时快照 + 结构隔离，导出包不含备注 |
| 4 | 重复投稿任务 | 幂等键去重，只执行一次 |
| 5 | 脱敏覆盖面 | 正文/字幕/旁白/清单全部过检 |
| 6 | 白名单与元数据 | 敏感字段不生成片段；EXIF GPS/机主剥离 |
| 7 | 领养完成 | 招领片撤回 + 旧发布任务取消（不带病完成） |
| 8 | 下载授权撤销 | 410 + 诚实声明外部副本无法追回 |
| 9 | 人工复核 | 人脸/声音/背景自动入队 |
