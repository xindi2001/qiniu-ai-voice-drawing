# 七牛 AI 语音绘图工具

通过中文语音或文本指令，在 Web 画布上绘制与编辑图形的 AI 驱动绘图应用。

- **前端**：Vue 3 + Vite + TypeScript + vue-konva
- **后端**：Java 17 + Spring Boot 3.2 + DeepSeek API + 阿里云 ASR（可选）
- **仓库**：[xindi2001/qiniu-ai-voice-drawing](https://github.com/xindi2001/qiniu-ai-voice-drawing)

## 项目简介

本项目将自然语言（文本或语音）解析为结构化绘图命令，并在 Konva 画布上实时执行。当前已实现：

- **文本 / 语音双通道输入**：文本框直接输入，或通过麦克风录音识别
- **LLM 指令解析**：DeepSeek 将中文描述转为 `draw / modify / delete / undo / redo / clear` 等动作；未配置 API Key 时自动降级为 Mock 关键词模式
- **画布上下文感知**：将当前图形列表 `sceneContext` 传给后端，支持「把上一个改成绿色」「删除最后一个圆」等指代改图
- **基础图形绘制**：圆、矩形、线段；配置 DeepSeek 后可理解位置与尺寸描述（如「画在左上角」「移到右边」）
- **语音体验**：阿里云 ASR（优先）或浏览器 Web Speech API（降级）；TTS 播报 `speak` 字段；可选「确认后再执行」
- **ASR 同音字纠错**：自动将「园」「元」等误识别修正为「圆」

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
- （可选）阿里云 AccessKey + NLS AppKey（服务端语音识别）

### 后端

```bash
cd backend

# 可选：配置 DeepSeek API Key（不配置则使用 Mock 模式）
# Windows PowerShell:
$env:DEEPSEEK_API_KEY="your_key_here"

# IntelliJ IDEA：Run Configuration → Environment variables
# 变量名必须是 DEEPSEEK_API_KEY（不是 EK_API_KEY 或其他名称）
# 示例：DEEPSEEK_API_KEY=sk-your_key_here

# 可选：阿里云 ASR（配置后前端优先使用服务端语音识别）
# ALIYUN_ACCESS_KEY_ID=your_access_key_id
# ALIYUN_ACCESS_KEY_SECRET=your_access_key_secret
# ALIYUN_ASR_APP_KEY=your_nls_app_key

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

### 快速验证

1. 打开 `http://localhost:5173`
2. 在文本框输入：`画一个红色的圆`
3. 点击「执行」，画布应出现红色圆形，右侧日志显示 JSON 与执行记录

## 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | 后端 | DeepSeek API 密钥，未设置时启用 Mock 模式 |
| `ALIYUN_ACCESS_KEY_ID` | 后端 | 阿里云 AccessKey ID，用于 NLS Token |
| `ALIYUN_ACCESS_KEY_SECRET` | 后端 | 阿里云 AccessKey Secret |
| `ALIYUN_ASR_APP_KEY` | 后端 | 智能语音交互项目 AppKey（见下方获取方式） |
| `VITE_API_BASE` | 前端 | 生产 / preview 模式下的后端根地址，如 `http://localhost:8080` |

**注意**：环境变量名必须为 `DEEPSEEK_API_KEY`（与 `application.yml` 中 `${DEEPSEEK_API_KEY:}` 一致）。常见错误：在 IDEA 中写成 `EK_API_KEY` 等错误名称，导致密钥未被读取（此时会走 Mock 模式，接口仍应返回 200）。

> **安全提示**：若 API Key 或 AccessKey 曾在截图或聊天中泄露，请立即在对应控制台**轮换密钥**，再更新 IDEA / 终端环境变量。切勿将真实密钥提交到 Git；`application.yml` 仅含 `${ENV_VAR:}` 占位符，可安全提交。

参考 `backend/.env.example` 与 `frontend/.env.example`。

### 获取阿里云 ASR AppKey

1. 登录 [阿里云智能语音交互控制台](https://nls-portal.console.aliyun.com/)
2. 创建项目（或进入已有项目），选择地域 **华东2（上海）**（与 `application.yml` 中 `cn-shanghai` 一致）
3. 在项目详情页复制 **AppKey**，设置为环境变量 `ALIYUN_ASR_APP_KEY`
4. 确保当前 RAM 用户 / AccessKey 已开通 **智能语音交互（NLS）** 权限
5. 重启后端；启动日志应显示 `Aliyun ASR configured: yes`

未配置 AppKey 时，前端自动降级为浏览器 **Web Speech API**，VoicePanel 会显示提示信息。

## 技术架构

```
用户输入（文本 / 语音）
    ↓
前端 VoicePanel → [阿里云 ASR] POST /api/v1/voice/transcribe  或  Web Speech API
    ↓  （ASR 同音字纠错：园/元 → 圆）
useVoiceApi → POST /api/v1/voice/parse  （携带 sceneContext）
    ↓
VoiceCommandController → VoiceCommandService → DeepSeekService
    ↓  （DeepSeek 不可用 / 无 Key → Mock 关键词降级）
返回 { speak, actions[], mockMode? }
    ↓
commandExecutor 执行绘图 → Konva 画布渲染 + TTS 播报 speak
```

| 层级 | 技术 |
|------|------|
| 语音识别 | 阿里云 NLS（服务端） / Web Speech API（浏览器降级） |
| 指令解析 | DeepSeek Chat API + Mock 关键词规则 |
| 前端 | Vue 3 + TypeScript + vue-konva + Vite |
| 后端 | Spring Boot 3.2 + RestTemplate |

### 后端三层结构

- **controller**：`VoiceCommandController`、`VoiceTranscribeController` — REST API
- **service**：`VoiceCommandService`、`DeepSeekService`、`AliyunAsrService`、`AliyunTokenService`
- **dto**：`VoiceParseRequest`、`VoiceParseResponse`、`DrawAction`

### 前端模块

- **components**：`DrawingBoard`、`KonvaCanvas`、`TextCommandInput`、`CommandLog`、`VoicePanel`
- **composables**：`useVoiceApi`、`useSpeechRecognition`、`useAudioRecorder`、`useSpeechSynthesis`
- **engine**：`commandExecutor`、`shapeFactory`

## 版本里程碑 / 功能概览

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
| 语音识别 | Web Speech API（zh-CN）；连续 / 按住说话模式 |
| 画布上下文 | `sceneContext` 传给后端，支持指代改图 |
| 修改 / 删除 | 「把上一个改成绿色」「删除最后一个」 |
| 体验增强 | 加载态、错误提示、TTS 播报 `speak`、日志区分语音/文本来源 |

Mock 模式已支持 modify / delete 及部分移动关键词（见 [DESIGN.md](./DESIGN.md)）。

### Day 3 — 联调与交付（进行中）

| 能力 | 状态 | 说明 |
|------|------|------|
| 阿里云 ASR | ✅ | 服务端录音转写，前端优先使用；未配置时降级 Web Speech |
| DeepSeek 环境配置 | ✅ | `DEEPSEEK_API_KEY` 规范命名；401/403 自动降级 Mock |
| ASR 同音字纠错 | ✅ | 「园」「元」→「圆」 |
| 确认后再执行 | ✅ | VoicePanel 可选，识别完成后手动确认再提交 |
| 位置 / 尺寸指令 | ✅ | DeepSeek 模式支持；Mock 部分支持移动关键词 |
| 端到端联调 | ✅ | 文本 + 语音 + 改图链路已验证 |
| GitHub Pages 部署 | ⏳ | `vite.config.ts` 已配置 base，待发布 |
| 生产后端部署 | ⏳ | 可选（Railway / Render 等） |
| 演示视频 | ⏳ | 待录制 |
| README 文档 | ⏳ | 持续更新中 |

## 功能验证步骤

按顺序执行以下指令，可覆盖核心能力（约 3–5 分钟）。建议配置 `DEEPSEEK_API_KEY` 以验证 LLM 解析；未配置时走 Mock 模式，基础步骤同样可用。

| 步骤 | 口令 | 阶段 | 预期效果 |
|------|------|------|----------|
| 1 | 画一个红色的圆 | Day 1 | 红圆 + TTS |
| 2 | 画一个蓝色的矩形 | Day 1 | 叠加矩形 |
| 3 | 画一条绿色的线 | Day 1 | 叠加线条 |
| 4 | 撤销 | Day 1 | 撤销线条 |
| 5 | 清空画布 | Day 1 | 画布清空 |
| 6 | 画一个红色的圆 → 把上一个改成绿色 | Day 2 | 改色 + TTS |
| 7 | 删除最后一个 | Day 2 | 删除图形 |
| 8 | 画一个圆 → 把圆移到左边 | Day 2/3 | 图形左移（DeepSeek 或 Mock） |
| 9 | 在左上角画一个黄色的小圆 | Day 3 | 指定位置与尺寸（需 DeepSeek） |
| 10 | 麦克风语音：「画一个蓝色的圆」 | Day 2/3 | ASR 识别 → 解析 → 绘图 |

**语音验证补充**

1. 配置阿里云 ASR 环境变量并重启后端（可选；未配置时使用 Web Speech）
2. 使用 Chrome 或 Edge，允许麦克风权限
3. VoicePanel 显示当前识别引擎（「阿里云 ASR」或「Web Speech API」）
4. 可勾选「确认后再执行」核对识别文字后再提交
5. 说「画一个圆」时，即使 ASR 识别为「画一个园」，同音字纠错后仍应正确绘图

详细命令设计见 [DESIGN.md](./DESIGN.md)。

## 支持的指令

| 指令示例 | 动作 | 说明 |
|----------|------|------|
| 画一个红色的圆 | draw circle | Mock + LLM |
| 画一个蓝色的矩形 | draw rect | Mock + LLM |
| 画一条绿色的线 | draw line | Mock + LLM |
| 在左上角画一个小圆 | draw circle | 主要依赖 DeepSeek |
| 撤销 / 重做 | undo / redo | Mock + LLM |
| 清空画布 | clear | Mock + LLM |
| 把上一个改成绿色 | modify | 需 sceneContext |
| 删除最后一个 | delete | 需 sceneContext |
| 把圆移到左边 | modify | DeepSeek；Mock 部分支持 |

## 已知限制

- **图形类型**：当前画布仅渲染圆（circle）、矩形（rect）、线段（line）三种基础图形；三角形、多边形等尚未实现
- **复杂物体**：「画一个房子」「画一棵树」等描述，LLM 会尝试分解为多个基础图形近似组合，效果有限且不稳定
- **图层与组合**：不支持 z-index 调整、图形编组或精确 CAD 级绘图
- **Mock 模式**：关键词规则较简单，位置与复杂指代主要依赖 DeepSeek
- **语音识别**：Web Speech API 依赖浏览器与网络；阿里云 ASR 需正确配置 AccessKey 与 AppKey
- **部署**：GitHub Pages 仅托管静态前端，生产环境需单独部署后端并配置 `VITE_API_BASE`

## 开发路线 / 后续计划

1. **已完成**：文本 / 语音输入、DeepSeek 解析、Mock 降级、sceneContext 改图、阿里云 ASR、同音字纠错 ✅
2. **进行中**：文档完善、端到端演示脚本 ✅ / GitHub Pages 部署 ⏳
3. **待做**：
   - GitHub Pages 前端发布 + 后端公网部署
   - 演示视频录制
   - 扩展图形类型（三角形、椭圆等）
   - 改进复杂物体的分解绘制策略

## Git 工作流

建议使用 **feature 分支 + Pull Request** 提交变更，避免直接在已合并或过时的分支上堆积提交：

1. 从最新 `master` 拉取并创建新分支（如 `feature/day3-docs-and-asr`）
2. 在新分支上完成开发与文档更新
3. 推送分支并发起 PR 合并到 `master`

不要在已合并且落后于 `master` 的旧 feature 分支（如 `feature/day2-voice-api`）上继续提交 Day 3 内容。

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

## GitHub Pages 部署（前端）

`vite.config.ts` 已配置 `base: '/qiniu-ai-voice-drawing/'`。

```bash
cd frontend
npm run build
# 将 dist/ 部署到 gh-pages 分支
```

> 生产环境需单独部署后端，并在 `frontend/.env.production` 中设置 `VITE_API_BASE` 指向后端地址。

## 故障排查

### 阿里云 NLS Token：`SignatureDoesNotMatch`

后端日志或转写接口报错含 `SignatureDoesNotMatch` 时，表示 CreateToken 请求签名与阿里云侧计算不一致，**不是** AppKey 或地域配置错误本身。

| 原因 | 处理方式 |
|------|----------|
| AccessKey ID 与 Secret 不是同一对 | 登录 [RAM AccessKey 管理](https://ram.console.aliyun.com/manage/ak)，确认 ID 与 Secret 来自同一条记录 |
| 环境变量含首尾空格 | 复制密钥后检查 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET` 无空格；代码已对读取值 `trim()`，修改后需重启后端 |
| 密钥已泄露或已轮换 | 在控制台禁用旧 Key、创建新 Key，更新 IDEA / 终端环境变量后重启 |
| 使用了错误账号的 Key | 确保 Key 所属主账号或 RAM 用户已开通 **智能语音交互（NLS）** 权限 |

失败时日志会输出 AccessKey ID **末 4 位**（不记录 Secret），便于核对是否加载了预期密钥。地域须与 NLS 项目一致，默认为 `cn-shanghai`（`nls-meta.cn-shanghai.aliyuncs.com`）。

### 前端显示「API 错误：请求失败 (403)」

**后端不会向客户端返回 403**（DeepSeek 401/403 会降级为 Mock 并返回 200）。403 通常表示请求 **未到达 Spring Boot**：

| 原因 | 处理方式 |
|------|----------|
| 后端未启动 | 在 `backend` 目录执行 `mvn spring-boot:run`，确认 `http://localhost:8080/api/v1/voice/health` 返回 `{"status":"ok"}` |
| 未使用 Vite 开发服务器 | 本地请用 `npm run dev`（5173），不要直接打开 `dist/index.html` |
| GitHub Pages / 生产构建 | 设置 `VITE_API_BASE` 为可访问的后端 HTTPS 地址 |
| IDEA 环境变量名写错 | 必须是 **`DEEPSEEK_API_KEY`**，不是 `EK_API_KEY`（写错只会禁用 LLM，不会导致 403） |

成功请求时，后端日志会出现 `POST /api/v1/voice/parse`。

### IntelliJ IDEA 运行配置

1. **Run → Edit Configurations** → 选择 `VoiceDrawingApplication`
2. 在 **Environment variables** 中添加（示例，请替换为你的密钥）：
   ```
   DEEPSEEK_API_KEY=sk-your_key_here;ALIYUN_ACCESS_KEY_ID=your_id;ALIYUN_ACCESS_KEY_SECRET=your_secret;ALIYUN_ASR_APP_KEY=your_app_key
   ```
3. 变量名必须完全一致（区分大小写），IDEA 中用分号分隔多个变量
4. 不配置 `DEEPSEEK_API_KEY` 时，启动日志显示 `DeepSeek configured: no`，Mock 模式可用
5. 不配置阿里云三项时，启动日志显示 `Aliyun ASR configured: no`，前端使用 Web Speech

### 验证后端

PowerShell：

```powershell
Invoke-WebRequest -Uri "http://localhost:8080/api/v1/voice/parse" `
  -Method POST -ContentType "application/json" `
  -Body '{"text":"画一个红色的圆"}' -UseBasicParsing
```

应返回 HTTP 200 及含 `"mockMode": true` 或 `"mockMode": false` 的 JSON。

**验证 ASR 状态**

```powershell
Invoke-WebRequest -Uri "http://localhost:8080/api/v1/voice/asr/status" -UseBasicParsing
```

配置阿里云环境变量后应返回 `"aliyunConfigured": true`。

**验证语音转写**（需麦克风录制的 wav 文件）

```powershell
Invoke-WebRequest -Uri "http://localhost:8080/api/v1/voice/transcribe" `
  -Method POST -Form @{ audio = Get-Item "test.wav" } -UseBasicParsing
```

## License

MIT
