# 七牛 AI 语音绘图工具

通过中文语音或文本指令，在 Web 画布上绘制与编辑图形的 AI 驱动绘图应用。

- **前端**：Vue 3 + Vite + TypeScript + vue-konva
- **后端**：Java 17 + Spring Boot 3.2 + DeepSeek API
- **仓库**：[xindi2001/qiniu-ai-voice-drawing](https://github.com/xindi2001/qiniu-ai-voice-drawing)

## 项目结构

```
├── frontend/          # Vue3 前端
├── backend/           # Spring Boot 后端
├── README.md
└── DESIGN.md          # 命令设计与实现计划
```

## 快速开始

### 环境要求

- Java 17+
- Maven 3.8+
- Node.js 18+
- （可选）DeepSeek API Key

### 后端

```bash
cd backend

# 可选：配置 DeepSeek API Key（不配置则使用 Mock 模式）
# Windows PowerShell:
$env:DEEPSEEK_API_KEY="your_key_here"

# 启动
mvn spring-boot:run
```

后端默认运行在 `http://localhost:8080`

### 前端

```bash
cd frontend
npm install
npm run dev
```

前端默认运行在 `http://localhost:5173`，开发环境通过 Vite 代理访问后端 `/api`。

### 验证

1. 打开 `http://localhost:5173`
2. 在文本框输入：`画一个红色的圆`
3. 点击「执行」，画布应出现红色圆形，右侧日志显示 JSON 与执行记录

## 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | 后端 | DeepSeek API 密钥，未设置时启用 Mock 模式 |

参考 `backend/.env.example`。

## 架构

```
用户输入（文本/语音）
    ↓
前端 useVoiceApi → POST /api/v1/voice/parse
    ↓
VoiceCommandController → VoiceCommandService → DeepSeekService
    ↓
返回 { speak, actions[] }
    ↓
commandExecutor 执行绘图 → Konva 画布渲染
```

### 后端三层结构

- **controller**：`VoiceCommandController` — REST API
- **service**：`VoiceCommandService`、`DeepSeekService` — 业务与 LLM 调用
- **dto**：`VoiceParseRequest`、`VoiceParseResponse`、`DrawAction`

### 前端模块

- **components**：`DrawingBoard`、`KonvaCanvas`、`TextCommandInput`、`CommandLog`、`VoicePanel`
- **composables**：`useVoiceApi`、`useSpeechRecognition`、`useSpeechSynthesis`
- **engine**：`commandExecutor`、`shapeFactory`

## API 示例

**请求**

```http
POST /api/v1/voice/parse
Content-Type: application/json

{ "text": "画一个红色的圆", "sceneContext": [] }
```

**响应**

```json
{
  "speak": "已画一个红色的圆",
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
  "mockMode": true
}
```

## 版本里程碑

### Day 1 — 基础框架与文本绘图 ✅

| 能力 | 说明 |
|------|------|
| 前后端骨架 | Spring Boot 三层 + Vue3/Konva 单页应用 |
| 指令解析 | `POST /api/v1/voice/parse`，DeepSeek API + Mock 关键词降级 |
| 文本绘图 | 圆 / 矩形 / 线，撤销 / 重做 / 清空 |
| 指令日志 | 展示「文本 → JSON → 执行结果」链路 |

### Day 2 — 语音与智能改图 ✅

| 能力 | 说明 |
|------|------|
| 语音识别 | Web Speech API（zh-CN），按住说话 + 连续识别 |
| 画布上下文 | `sceneContext` 传给后端，支持指代改图 |
| 修改 / 删除 | 「把上一个改成绿色」「删除最后一个」 |
| 体验增强 | 加载态、错误提示、TTS 播报 `speak`、日志区分语音/文本来源 |

Mock 模式已支持 modify / delete 及部分移动关键词（见 [DESIGN.md](./DESIGN.md) P1 说明）。

### Day 3 — 待完成 ⏳

- 端到端联调与功能验证
- GitHub Pages 前端部署
- 生产后端部署（可选）
- 演示视频录制
- README 终稿

## 功能验证步骤

按顺序执行以下指令，可覆盖 MVP 核心能力（约 2–3 分钟）：

| 步骤 | 口令 | 阶段 | 预期效果 |
|------|------|------|----------|
| 1 | 画一个红色的圆 | Day 1 | 红圆 + TTS |
| 2 | 画一个蓝色的矩形 | Day 1 | 叠加矩形 |
| 3 | 画一条绿色的线 | Day 1 | 叠加线条 |
| 4 | 撤销 | Day 1 | 撤销线条 |
| 5 | 清空画布 | Day 1 | 画布清空 |
| 6 | 画一个红色的圆 → 把上一个改成绿色 | Day 2 | 改色 + TTS |
| 7 | 删除最后一个 | Day 2 | 删除图形 |
| 8 | 麦克风语音输入 | Day 2 | 识别并自动绘图 |

> 未配置 `DEEPSEEK_API_KEY` 时走 **Mock 模式**，以上步骤均可完成，便于本地快速验证。

详细命令设计与实现状态见 [DESIGN.md](./DESIGN.md)。

## 支持的指令（MVP）

| 指令示例 | 动作 |
|----------|------|
| 画一个红色的圆 | draw circle |
| 画一个蓝色的矩形 | draw rect |
| 画一条绿色的线 | draw line |
| 撤销 / 重做 | undo / redo |
| 清空画布 | clear |
| 把上一个改成绿色 | modify（需 sceneContext） |
| 删除最后一个 | delete（需 sceneContext） |

### 语音输入

1. 使用 Chrome 或 Edge 打开页面
2. 允许麦克风权限
3. 点击「开始录音」说话，或开启「连续识别模式」
4. 识别完成后自动解析并绘图，同时 TTS 播报 `speak` 字段

更多命令规划见 [DESIGN.md](./DESIGN.md)。

## GitHub Pages 部署（前端）

`vite.config.ts` 已配置 `base: '/qiniu-ai-voice-drawing/'`。

```bash
cd frontend
npm run build
# 将 dist/ 部署到 gh-pages 分支
```

> 生产环境需单独部署后端并更新 `useVoiceApi.ts` 中的 API 地址。

## 开发路线

1. **Day 1**：文本指令 + Mock/LLM 解析 + 基础绘图 ✅
2. **Day 2**：Web Speech API、modify/delete、sceneContext、错误处理 ✅
3. **Day 3**：联调、GitHub Pages 部署、演示录制 ⏳

## License

MIT
