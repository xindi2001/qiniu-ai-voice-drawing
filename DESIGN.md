# 七牛 AI 语音绘图 — 设计文档

## 1. 产品目标

用户通过**纯语音或文本**描述绘图意图（无鼠标绘图），系统完成：

**语音 → ASR → 文本 → AI 解析 → AI 生成参考位图 → 矢量化 → 路径排序 → 拆分 → SVG 逐帧绘制**

在前端 Konva 画布上以笔画动画执行并 TTS 语音反馈。

MVP 策略：文本优先调试，语音后接入，分阶段交付可演示版本。

---

## 2. 完整管线图

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│ 麦克风/文本  │───▶│ ASR (可选)   │───▶│ 同音字纠错       │
└─────────────┘    └──────────────┘    └────────┬────────┘
                                                 ▼
                                    POST /api/v1/voice/parse
                                    (text + sceneContext + fineDetailMode)
                                                 ▼
                                    DeepSeekService 路由
                                    (dashscopeConfigured 决定万相/简笔)
                                                 ▼
              ┌──────────────────────────────────┴──────────────────────────┐
              │ draw_stroke          draw_paths              generate_and_trace │
              │ 圆/矩形/线/三角      无万相时的复杂主体       有万相时的复杂主体   │
              └──────────┬─────────────────┬────────────────────┬────────────┘
                         ▼                 ▼                    ▼
                   strokeAnimator    pathItems 逐笔        POST /generate-image
                         │                 │                    ▼
                         │                 │              WanxImageService
                         │                 │                    ▼
                         │                 │           imageVectorizer (imagetracerjs)
                         │                 │           子路径拆分 → 聚类排序 → 逐笔动画
                         └─────────────────┴────────────────────┘
                                           ▼
                              Konva 画布 + TTS speak + 进度 UI
```

---

## 3. 命令分级（Planned / Implemented / Not Done）

### P0 — MVP 核心

| 命令 | 示例 | 状态 | 说明 |
|------|------|------|------|
| 画圆 | 「画一个红色的圆」 | ✅ 已实现 | `draw_stroke` 弧线扫动画 |
| 画矩形 | 「画一个蓝色矩形」 | ✅ 已实现 | 四边顺序笔画 |
| 画线 | 「画一条线」 | ✅ 已实现 | 端点插值 |
| 撤销/重做/清空 | 「撤销」 | ✅ 已实现 | undo/redo 栈 |

### P1 — 语音与改图

| 命令 | 示例 | 状态 | 说明 |
|------|------|------|------|
| 修改/删除 | 「把圆改成绿色」 | ✅ 已实现 | sceneContext + targetId |
| 语音输入 | 麦克风 | ✅ 已实现 | 阿里云 ASR 优先，Web Speech 降级 |
| TTS 播报 | speak 字段 | ✅ 已实现 | Web Speech Synthesis |
| 同音字纠正 | 园→圆 | ✅ 已实现 | AsrHomophoneHelper |
| 确认后再执行 | VoicePanel 开关 | ✅ 已实现 | 纯语音演示友好 |
| 鼠标禁用 | 画布 | ✅ 已实现 | listening:false，仅语音/文本驱动 |

### P2 — 生图描摹管线

| 命令 | 示例 | 状态 | 说明 / 未做原因 |
|------|------|------|----------------|
| 几何笔画 | 「画一个三角形」 | ✅ draw_stroke | 不调用万相 |
| 复杂物体（有万相） | 「画一匹马」 | ✅ generate_and_trace | **DASHSCOPE 配置时默认万相** |
| 复杂物体（无万相） | 「画一匹马」 | ✅ draw_paths | tier2 多段折线模板兜底 |
| 万相失败降级 | 生图/矢量化失败 | ✅ draw_paths | `resolvePathItemsFromPrompt` 按主体选模板 |
| 精细描摹 | fineDetailMode 勾选 | ✅ 已实现 | 768 分辨率 + 更长 trace 超时 |
| 进度 UI | 构思中/落笔规划中/绘制中(N/M) | ✅ 已实现 | DrawingBoard paintMessage（用户向文案，不暴露 AI 生图） |
| 指令日志 action 类型 | CommandLog badge | ✅ 已实现 | generate_and_trace / draw_paths 等 |
| 图层管理 | z-index | ❌ 未实现 | 非 bootcamp MVP |
| 历史回放 | 时间线 | ❌ 未实现 | 非 MVP |
| GitHub Pages | 静态部署 | ⏳ 计划中 | vite base 已配置，待发布 |
| 生产后端 | 公网 API | ⏳ 计划中 | 需 VITE_API_BASE |

---

## 4. 三种绘图模式与路由（当前实现）

| 模式 | action | 触发条件 | 管线 |
|------|--------|----------|------|
| 几何笔画 | `draw_stroke` | 圆/矩形/线/三角形 | strokeAnimator，不调万相 |
| 简笔多段 | `draw_paths` | 复杂主体 + **无** DASHSCOPE | pathItems ≤12，tier2 模板 |
| 万相描摹 | `generate_and_trace` | 复杂主体 + **有** DASHSCOPE | 万相 → imagetracerjs 矢量化 → 质量门控 → 逐笔动画 |

**复杂主体**：马、牛、羊、猫、狗、鸟、车、树、房子、太阳、星星、花、人、头像/动漫

**路由实现位置**：
- `DeepSeekService.SYSTEM_PROMPT` — LLM 指引
- `DeepSeekService.shouldUseGenerateAndTrace()` — 后端强制逻辑
- `DeepSeekService.enforceRouting()` — LLM 返回错误 action 时纠正
- `DeepSeekService.mockParse()` — Mock/纠正模板

**fineDetailMode**：提升万相 prompt 细节、768 分辨率、更多边缘路径、更长描摹超时（75s）

---

## 5. 数据协议

### 请求

```json
{
  "text": "画一匹马",
  "sceneContext": [],
  "fineDetailMode": false
}
```

### 响应（DASHSCOPE 已配置）

```json
{
  "speak": "好的，开始描绘一匹马",
  "actions": [{
    "action": "generate_and_trace",
    "mode": "picture",
    "imagePrompt": "马，侧面，simple black line art，white background，no fill，coloring book style，黑白线稿…"
  }],
  "mockMode": false
}
```

### action 类型

| action | 必填 | 说明 |
|--------|------|------|
| draw_stroke | action | 简单几何 |
| draw_paths | action, pathItems | 无万相时的复杂简笔 |
| generate_and_trace | action, imagePrompt | 万相 + 矢量化描摹 |

---

## 6. 后端组件

| 类 | 职责 |
|----|------|
| `DashScopeConfig` | `${DASHSCOPE_API_KEY:}` |
| `WanxImageService` | 线稿 prompt 增强、异步生图、base64 下载 |
| `ImageGenController` | `/generate-image`、`/image-gen/status` |
| `DeepSeekService` | 路由 + mock + enforceRouting |
| `AliyunAsrService` | 服务端 ASR |

---

## 7. 前端组件

| 模块 | 职责 |
|------|------|
| `commandExecutor.ts` | 统一 `executeActionsAnimated`，构思进度回调 + 主体感知质量门控 + 车辆边缘模式 + 两阶段描摹 |
| `imageVectorizer.ts` | imagetracerjs 矢量化：2× 预处理 → 二值化 → RDP 平滑 → 排线过滤 → **pathDedup** → 排序 |
| `outlineVectorizer.ts` | **外轮廓专用**：背景泛洪 → 最大连通域 → 轮廓环 → imagetracer；不足时回退最长 15 路径 |
| `preprocessImage.ts` | 高斯模糊 → 阈值二值化 → 轻量细化，2× 放大追踪 |
| `pathSmoother.ts` | RDP 简化、邻近路径合并、排线/涂抹检测、**deduplicatePaths** |
| `pathDedup.ts` | bbox IoU >85% 去重、平行偏移 <5px 合并、主体笔画上限（车12/人像15/动物18） |
| `edgeVectorizer.ts` | **车辆专用** Sobel 峰值边缘（Canny-lite），cap 12 笔 ≥40px |
| `pathSorter.ts` | **子路径拆分** + **空间聚类排序**；动物外轮廓 cap 18 笔 |
| `tier2Paths.ts` | 万相失败时的主体感知 fallback 模板 |
| `strokeAnimator.ts` | 批量描摹（batch=2）+ **两阶段描摹**（前 5 笔 1.5s 慢，其余加速） |

---

## 8. 已知限制（诚实说明）

| 限制 | 说明 |
|------|------|
| 万相延迟 | 通常 8–15 秒（demo turbo 768）或 15–45 秒（精细 plus 1024）；UI 显示「构思参考图… (Ns)」 |
| 本地 prep | demo 模式 ≤800ms（256px 边缘勾线 + 4 色 posterize）；精细 ≤3s（384px + ImageTracer）；超时回退 4 笔 + 3 色带 |
| 端到端目标 | **录演示**：万相 8–15s + prep 1s + 动画 3s ≈ **12–20s**；精细模式 30–45s 可接受 |
| 矢量化质量 | 万相 PNG → **全图追踪**（头像/精细）或 **Sobel 边缘**（车辆）或 **外轮廓**（动物）；pathDedup 去重叠笔；主体 cap：车 **12** / 人像 **15** / 动物 **18**；最短：车 **40px** / 人像 **35px** |
| 路径排序 | **空间聚类**（bbox 重叠或质心 <80px）→ 最大簇优先 → 簇内最近邻；拒绝 >25% 画布对角线的跳跃边 |
| LLM 路由 | DeepSeek 可能仍返回 draw_paths，由 enforceRouting 纠正 |
| 无万相 | 复杂物体仅为简笔折线，非写实 |
| 部署 | GitHub Pages 仅静态前端，需独立后端 |

### 矢量化管线（generate_and_trace）— 去重 + 主体分流

**进度 UX（用户向）**：

| 阶段 | 文案 |
|------|------|
| 万相异步 | **构思参考图… (Ns)** — turbo 768（默认）或 plus 1024（精细） |
| 参考图就绪 | **加载参考图…** → **准备勾线…**（拆分 decode 与分析） |
| 勾线动画 | **勾线中（N/M）…** |
| 上色动画 | **上色中（N/M）…** |

### 延迟设计（bootcamp / 录演示）

勾线+上色模式的端到端延迟分三段：**万相 API**（网络，8–45s）、**本地 prep**（主线程分析，目标 ≤1s）、**动画**（可控，demo 约 3s）。此前「解析参考图…」卡数分钟的根因是 Wanx 返回后在主线程同步跑 **ImageTracer**（`traceLineArtContours`）+ 全分辨率 mask 缩放；超时回退又调用同等重量的 `buildInstantDefaultSketchResult`，等于 abort 后继续阻塞。

**demoFastMode**（精细模式关闭时默认）：256px 工作区、Sobel 边缘勾线（跳过 ImageTracer）、4 色 posterize、25 笔 × 80ms + 4 区 × 300ms；prep 硬超时 **800ms**，AbortController 回退 **4 边缘笔 + 3 水平色带**（仍为真实 dash 动画，非 tier2 椭圆）。**精细模式**：384px + ImageTracer 轮廓、完整语义分区，prep 超时 **3s** 后同样回退。录演示请关闭「精细描摹」；需要质量时再打开。

CommandLog 仍保留「万相描摹」等技术 badge，与底部进度条分离。

**pathDedup 策略**（`pathDedup.ts`）：

1. 按路径长度降序遍历
2. 若候选路径与已保留路径 bbox IoU（min-area）≥ **85%** → 丢弃（消除轮毂/尾翼重叠线）
3. 若两路径质心偏移 < **5px** 且方向平行、长度相近 → 保留较长者
4. 按主体 cap 截断：vehicle **12** / portrait **15** / animal **18** / default **30**

**根因**：复合 SVG path（多个 `M…L` 子路径）被当作单条笔画动画 → Konva 在子路径间画连接线 → 脸上随机横线、车体乱连。

**修复**：

1. **万相 prompt 增强**（`WanxImageService`）：
   - 动物：`outline silhouette only`（外轮廓剪影）
   - 跑车：`minimal 8 line side view, no wheel spokes detail, no shading`
   - 头像：`anime face portrait line art, 10 strokes outline, no random lines across face`
2. **追踪模式路由**（`commandExecutor` + `detectTraceSubject`）：
   - **外轮廓**（`outlineVectorizer`）：马/牛/斑马等动物剪影，cap 18
   - **Sobel 边缘**（`edgeVectorizer`）：车/跑车/汽车 — 高阈值峰值、无 erosion、cap 12、≥40px
   - **全图追踪 + 激进清理**（`imageVectorizer`）：头像/动漫/人像/精细模式，cap 15、≥35px
3. **子路径拆分**（`svgPathParser.parsePathDAll` + `pathSorter.splitPathDIntoItems`）：
   - 每个 `M/m` moveto 拆成独立 `PathItem`，**绝不**将多子路径合并为单条动画线
4. **路径后处理**（`pathSmoother` + `pathDedup` + `imageVectorizer`）：
   - RDP 简化 → 排线/水平线过滤 → **deduplicatePaths** → **禁用跨路径 merge**
5. **空间聚类排序**（`pathSorter.clusterPaths` + `nearestNeighborSortCluster`）：
   - 按 bbox 重叠或质心距离 <80px 分簇 → **最大簇先画**
   - 簇内最近邻排序；跳跃 >25% 画布对角线时断开（不连笔）
6. **两阶段描摹**（`strokeAnimator.animatePathsTwoPhase`）：复杂主体（车/人像）先慢画最长 5 笔（1.5s/笔）建立剪影，再加速细节
7. **Konva 渲染**（`strokeAnimator`）：每条 `PathItem` 独立 `animatePathStroke`，路径 A 终点不连路径 B 起点
8. **调试 UX**：描摹前 1 秒在画布右下角显示半透明构思参考缩略图
9. **质量门控**：有效路径 <3 或平均长度 <15px → 降级 tier2 简笔模板

旧版默认全量外轮廓模式已改为按主体类型分流；`outlineVectorizer` 仍供动物剪影使用。

---

## 9. 纯语音演示脚本

```
1. 勾选「确认后再执行」（可选，便于核对 ASR）
2. 「开始录音」→「画一匹马」→「停止并识别」→「确认执行」
   预期：日志 badge「万相描摹」，进度「构思中…→落笔规划中…→绘制中（N/M）…」
3. 「画一个红色的圆」→ draw_stroke 几何动画
4. 「撤销」
5. 「画一个精细的动漫头像」+ 勾选精细描摹 → 更高质量万相
6. 断开 DASHSCOPE 重启后端 →「画一匹马」降级为 draw_paths 简笔
```

---

## 10. 技术决策摘要

- **为何默认万相（有 Key）**：bootcamp 要求 AI 生图 → 矢量化 → 描摹，简笔 polygon 不满足「画一匹马」质量预期
- **为何禁用鼠标**：产品定位为纯语音/AI 驱动交互
- **降级链**：万相未配置 / 生图失败 / 边缘为空 → `tier2Paths` 主体模板（非单矩形）
