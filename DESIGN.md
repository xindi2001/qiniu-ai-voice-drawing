# 七牛 AI 语音绘图 — 设计文档

## 1. 产品目标

用户通过中文语音或文本描述绘图意图，系统调用 LLM 将自然语言解析为结构化绘图命令，在前端 Konva 画布上执行并语音反馈。

MVP 策略：**文本优先调试，语音后接入**，确保 3 天内可提交可演示版本。

---

## 2. 命令分级

### P0 — 必须实现（MVP 核心）

| 命令 | 示例 | 状态 | 说明 |
|------|------|------|------|
| 画圆 | 「画一个红色的圆」 | ✅ 已实现 | Mock + LLM 均支持 |
| 画矩形 | 「画一个蓝色矩形」 | ✅ 已实现 | |
| 画线 | 「画一条线」 | ✅ 已实现 | |
| 撤销 | 「撤销」 | ✅ 已实现 | undo 栈 |
| 重做 | 「重做」 | ✅ 已实现 | redo 栈 |
| 清空 | 「清空画布」 | ✅ 已实现 | |

### P1 — 重要增强（Day 2 目标）

| 命令 | 示例 | 状态 | 说明 |
|------|------|------|------|
| 修改颜色 | 「把圆改成绿色」 | ✅ 已实现 | sceneContext + targetId |
| 删除图形 | 「删除最后一个圆」 | ✅ 已实现 | sceneContext 语义引用 |
| 移动图形 | 「把圆移到左边」 | ⏳ Mock 部分支持 | Mock 支持左右上下偏移 |
| 语音输入 | 麦克风说话 | ✅ 已实现 | Web Speech API zh-CN |
| TTS 播报 | speak 字段 | ✅ 已实现 | Web Speech Synthesis |

### P2 — 锦上添花（时间允许）

| 命令 | 示例 | 状态 | 原因 |
|------|------|------|------|
| 多图形组合 | 「画一个房子」 | ❌ | 需复杂 prompt 与图形组合逻辑 |
| 图层管理 | 「把矩形放到圆上面」 | ❌ | 需 z-index 与引用系统 |
| 自由手绘 | 鼠标拖动画图 | ❌ 故意禁用 | 保证演示完整性，避免与语音指令混淆 |
| 历史回放 | 查看操作时间线 | ❌ | 非 Bootcamp 硬性要求 |
| 多语言 | 英文指令 | ❌ | 聚焦中文场景 |

---

## 3. 数据协议

### 请求

```json
{
  "text": "画一个红色的圆",
  "sceneContext": [
    {
      "id": "shape-1",
      "shape": "circle",
      "color": "#ef4444",
      "x": 300,
      "y": 200,
      "radius": 50
    }
  ]
}
```

### 响应

```json
{
  "speak": "好的，已为您画好红色圆形",
  "actions": [
    {
      "action": "draw",
      "shape": "circle",
      "color": "#ef4444",
      "x": 300,
      "y": 200,
      "radius": 50
    }
  ],
  "mockMode": false
}
```

### action 类型

| action | 必填字段 | 可选字段 |
|--------|----------|----------|
| draw | action, shape | color, x, y, width, height, radius, x1, y1, x2, y2 |
| modify | action, targetId | color, x, y, width, height, radius |
| delete | action, targetId | — |
| undo | action | — |
| redo | action | — |
| clear | action | — |

---

## 4. 技术决策

### 为何文本优先？

- Web Speech API 浏览器兼容性不一致，调试成本高
- 文本输入可快速验证 LLM 解析与命令执行链路
- 语音 composable 已预留，Day 2 可无缝切换

### 为何禁用鼠标绘图？

- Bootcamp 演示需体现「语音/AI 驱动」差异化
- 避免评委误以为是普通画板工具

### Mock 模式

未配置 `DEEPSEEK_API_KEY` 时，后端用关键词规则返回预设命令，保证无 Key 也能本地演示。

### DeepSeek 选型

- OpenAI 兼容 API，Spring `RestTemplate` 即可调用
- 中文理解较好，成本可控
- API Key 仅在后端，不暴露给前端

---

## 5. 未实现项与原因

| 功能 | 原因 | 计划 |
|------|------|------|
| 完整语音识别 | MVP 聚焦文本链路 | ✅ Day 2 已接入 Web Speech API |
| 图形语义引用（「那个圆」） | 需维护图形上下文传给 LLM | ✅ Day 2 传 sceneContext |
| 后端持久化 | 无状态绘图，Bootcamp 不要求 | 不计划实现 |
| 用户认证 | 单用户演示场景 | 不计划实现 |
| 生产后端部署 | 脚手架阶段仅本地 | Day 3 可选 Railway/Render |

---

## 6. 3 天里程碑

### Day 1（本脚手架）✅

- [x] 前后端项目骨架
- [x] POST /api/v1/voice/parse
- [x] DeepSeek 集成 + Mock 降级
- [x] 文本输入 → 画布绘制
- [x] undo/redo/clear

### Day 2 ✅

- [x] 接入 Web Speech API（zh-CN、连续/按住说话）
- [x] sceneContext 传给后端，完善 modify/delete prompt
- [x] Mock 模式支持修改/删除/移动关键词
- [x] 加载状态、错误提示、TTS 播报
- [x] 指令日志区分语音/文本来源

### Day 3

- [ ] 端到端联调与演示脚本
- [ ] GitHub Pages 前端部署
- [ ] 录制演示视频
- [ ] README 完善与提交

---

## 7. 演示脚本建议

```
1. 「画一个红色的圆」        → 出现红圆 + TTS
2. 「画一个蓝色的矩形」      → 叠加矩形
3. 「画一条绿色的线」        → 叠加线条
4. 「撤销」                  → 撤销线条
5. 「清空画布」              → 清空
6. 「把上一个改成绿色」      → 修改颜色 + TTS（需先有图形）
7. 「删除最后一个」          → 删除图形
8. 点击麦克风语音输入        → Web Speech API 识别并执行
```
