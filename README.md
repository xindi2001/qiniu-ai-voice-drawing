# 七牛 AI 语音绘图工具

七牛 AI Bootcamp 参赛作品 — 通过中文语音/文本指令在画布上绘图的 MVP 脚手架。

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
- **composables**：`useVoiceApi`、`useSpeechRecognition`（占位）、`useSpeechSynthesis`
- **engine**：`commandExecutor`、`shapeFactory`

## API 示例

**请求**

```http
POST /api/v1/voice/parse
Content-Type: application/json

{ "text": "画一个红色的圆" }
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

## 支持的指令（MVP）

| 指令示例 | 动作 |
|----------|------|
| 画一个红色的圆 | draw circle |
| 画一个蓝色的矩形 | draw rect |
| 画一条绿色的线 | draw line |
| 撤销 / 重做 | undo / redo |
| 清空画布 | clear |

更多命令规划见 [DESIGN.md](./DESIGN.md)。

## GitHub Pages 部署（前端）

`vite.config.ts` 已配置 `base: '/qiniu-ai-voice-drawing/'`。

```bash
cd frontend
npm run build
# 将 dist/ 部署到 gh-pages 分支
```

> 生产环境需单独部署后端并更新 `useVoiceApi.ts` 中的 API 地址。

## 开发路线（3 天）

1. **Day 1**：文本指令 + Mock/LLM 解析 + 基础绘图 ✅（本脚手架）
2. **Day 2**：接入 Web Speech API、完善 modify/delete、错误处理
3. **Day 3**：联调、GitHub Pages 部署、演示录制

## License

MIT
