package com.qiniu.voicedrawing.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.qiniu.voicedrawing.config.DashScopeConfig;
import com.qiniu.voicedrawing.config.DeepSeekConfig;
import com.qiniu.voicedrawing.dto.DrawAction;
import com.qiniu.voicedrawing.dto.PathItem;
import com.qiniu.voicedrawing.dto.SceneShapeContext;
import com.qiniu.voicedrawing.dto.VoiceParseResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class DeepSeekService {

    private static final Logger log = LoggerFactory.getLogger(DeepSeekService.class);

    private static final String SYSTEM_PROMPT = """
            你是一个语音绘图助手。将用户的中文语音/文本指令解析为结构化 JSON 绘图命令。
            只返回 JSON，不要其他说明。格式如下：
            {
              "speak": "开始绘制前的简短确认（将来式/进行式），如「好的，开始画一匹马」，禁止过去式「已画好」",
              "actions": [
                {
                  "action": "draw_stroke|draw_paths|generate_and_trace|useIcon|draw|drawPath|modify|delete|undo|redo|clear",
                  "mode": "geometry|picture",
                  "shape": "circle|rect|line",
                  "color": "#ff0000",
                  "strokeOnly": false,
                  "x": 200, "y": 150,
                  "width": 100, "height": 80,
                  "radius": 50,
                  "x1": 50, "y1": 50, "x2": 200, "y2": 200,
                  "points": [[x1,y1],[x2,y2],...],
                  "pathItems": [{ "points": [[x,y],...], "color": "#1f2937" }],
                  "paths": ["M 10 10 L 20 20 ..."],
                  "imagePrompt": "跑车，侧面，高质量数字插画，清晰线稿，适度细节，完整车身，白底，无人物",
                  "animateMs": 1300,
                  "closed": true,
                  "targetId": "可选，修改/删除目标图形的 id"
                }
              ]
            }
            路由规则（重要，按优先级；用户消息会标明 dashscopeConfigured 是否已配置万相）：
            1. 简单几何（圆/矩形/线/三角形/改色/删除/undo）→ action=draw_stroke，mode=geometry，不调用万相
            2. 空心圆/圆环/描边圆 → draw_stroke shape=circle，strokeOnly=true
            3. dashscopeConfigured=true 时，复杂主体（马/牛/羊/猫/狗/鸟/车/树/房子/太阳/星星/花/玫瑰/人/头像）→ action=generate_and_trace，mode=picture
               - 默认「画一匹马」「画一辆跑车」等均走万相描摹，无需用户说「精细」
               - imagePrompt 必须忠实用户指令的单一主体，禁止添加无关人物/动物/车辆
               - 用户说跑车/汽车 → imagePrompt 仅描述车辆，须含 no people、no driver、仅一辆车
               - 用户说马/动物 → 仅该动物，禁止额外人物
               - imagePrompt 须含：digital illustration, clear linework, moderate detail, complete full subject in frame, white background
               - 以及中文：高质量插画、清晰线稿、适度细节、完整主体、白底
               - 用户说「动漫/卡通/Q版」→ 追加 flat cartoon、flat color blocks
               - 用户说「头像/肖像/写生/细节/写实」→ 追加 detailed illustration、moderate detail（禁止 chibi / 扁平Q版）
               - fineDetailMode=true 或口令含「精细/高清/详细」→ imagePrompt 追加 detailed illustration、traceable line art（禁止 photorealistic / 写实照片）
               - 禁止对复杂主体返回 draw_paths 或单个矩形
            4. dashscopeConfigured=false 时，复杂主体 → action=draw_paths，mode=geometry
               - pathItems: 最多 12 条开放折线，每条 { points: [[x,y],...], color }
               - 马/树/房子/太阳/人 → 必须多段折线 pathItems，禁止单个矩形
               - 跑车/汽车无万相时可用 useIcon iconId=mdi:car-sports；花可用 mdi:flower
            draw_stroke 规则：
            - 画圆/矩形/线：action=draw_stroke，shape=circle|rect|line，提供位置尺寸
            - 画三角形/星形：action=draw_stroke，points 数组（至少 3 点），closed=true
            - 禁止用单个 draw_stroke rect 代替复杂主体
            draw_paths 规则（仅 dashscopeConfigured=false 时用于复杂主体）：
            - action=draw_paths，pathItems 数组，每条 path 独立 color
            - 仅轮廓描边，禁止内部排线/阴影/大面积灰色填充
            - 最多 12 条 path，每条为开放折线或简单闭合外轮廓
            - 示例「画一匹马」→ 椭圆躯干+颈+头+多段腿+尾，居中 canvas（约 480,300）
            - speak 用开始确认：「好的，开始画一匹马」，禁止过去式「已画好」
            generate_and_trace 规则：
            - action=generate_and_trace，mode=picture，imagePrompt 为通义万相生图提示词
            - imagePrompt 必须忠实用户说的主体，单一主体，禁止添加无关元素
            - imagePrompt 必须包含：digital illustration, clear linework, moderate detail, complete full subject in frame, white background
            - 以及中文：高质量插画、清晰线稿、适度细节、完整主体、白底
            - 默认 NOT chibi、NOT flat cartoon；仅用户明确说动漫/卡通/Q版时才用 flat cartoon 风格
            - 示例：「画一辆跑车」→ imagePrompt 含 跑车、侧面、complete side view sports car、full vehicle side profile complete、single car only、no people
            - 示例：「画一匹马」→ imagePrompt 含 马、侧面、single animal only、no people
            - 示例：「画一个精细头像」→ imagePrompt 含 肖像、portrait、detailed facial features、single person only
            其他规则：
            - draw/drawPath 仍兼容，但新指令优先 draw_stroke / draw_paths
            - 颜色用十六进制，如红色 #ff0000、蓝色 #0000ff、绿色 #00ff00
            - 未指定位置时：居中 x=480,y=300；左上角 x=80,y=60
            - animateMs 可选，默认 1200-1500，控制单笔画动画时长
            - draw 动作前端按 draw_stroke 动画播放
            - undo/redo/clear 只需 action 字段
            - 支持组合指令，多个 action 按顺序执行
            - 用户消息中会附带当前画布图形列表 sceneContext
            - modify/delete 使用 sceneContext 中的 id 作为 targetId
            - speak 字段：开始绘制前简短确认（如「好的，开始画一匹马」），禁止过去式
            - 播报文字必须用「画」不用「话」（如「画一匹马」而非「话一匹马」）
            - 「上一个」「最后一个」指列表中最后一项
            """;
    private static final Pattern CODE_BLOCK_PATTERN =
            Pattern.compile("```(?:json)?\\s*([\\s\\S]*?)```", Pattern.CASE_INSENSITIVE);

    private final DeepSeekConfig deepSeekConfig;
    private final DashScopeConfig dashScopeConfig;
    private final ObjectMapper objectMapper;
    private final RestTemplate restTemplate;

    public DeepSeekService(DeepSeekConfig deepSeekConfig, DashScopeConfig dashScopeConfig,
                           ObjectMapper objectMapper) {
        this.deepSeekConfig = deepSeekConfig;
        this.dashScopeConfig = dashScopeConfig;
        this.objectMapper = objectMapper;
        this.restTemplate = new RestTemplate();
    }

    public VoiceParseResponse parseCommand(String text, List<SceneShapeContext> sceneContext,
                                           Boolean fineDetailMode) {
        if (!deepSeekConfig.isConfigured()) {
            log.info("DeepSeek API key not configured, using mock mode");
            return mockParse(text, sceneContext, fineDetailMode);
        }

        try {
            String content = callDeepSeekApi(text, sceneContext, fineDetailMode);
            String json = stripMarkdownCodeBlocks(content);
            VoiceParseResponse response = parseJsonResponse(json, false);
            return enforceRouting(response, text, sceneContext, fineDetailMode);
        } catch (RestClientResponseException e) {
            int status = e.getStatusCode().value();
            if (status == 401 || status == 403) {
                log.warn("Invalid DeepSeek API key (HTTP {}), falling back to mock mode", status);
            } else {
                log.warn("DeepSeek API returned HTTP {} ({}), falling back to mock mode",
                        status, e.getStatusText());
            }
            return mockParse(text, sceneContext, fineDetailMode);
        } catch (Exception e) {
            log.warn("DeepSeek API call failed, falling back to mock: {}", e.getMessage());
            return mockWithWarning(text, sceneContext, fineDetailMode,
                    "DeepSeek API 不可用，已降级为 Mock 模式: " + e.getMessage());
        }
    }

    private VoiceParseResponse mockWithWarning(String text, List<SceneShapeContext> sceneContext,
                                               Boolean fineDetailMode, String warning) {
        VoiceParseResponse response = mockParse(text, sceneContext, fineDetailMode);
        response.setWarning(warning);
        return response;
    }

    private String callDeepSeekApi(String text, List<SceneShapeContext> sceneContext,
                                   Boolean fineDetailMode) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(deepSeekConfig.getApiKey());

        String userContent = buildUserMessage(text, sceneContext, fineDetailMode);

        Map<String, Object> body = new HashMap<>();
        body.put("model", deepSeekConfig.getModel());
        body.put("temperature", 0.2);
        body.put("messages", List.of(
                Map.of("role", "system", "content", SYSTEM_PROMPT),
                Map.of("role", "user", "content", userContent)
        ));

        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);
        ResponseEntity<String> response = restTemplate.postForEntity(
                deepSeekConfig.getApiUrl(), entity, String.class);

        JsonNode root = objectMapper.readTree(response.getBody());
        return root.path("choices").path(0).path("message").path("content").asText();
    }

    private String buildUserMessage(String text, List<SceneShapeContext> sceneContext,
                                    Boolean fineDetailMode) throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("用户指令：").append(text);
        sb.append("\n\ndashscopeConfigured=").append(dashScopeConfig.isConfigured());
        if (dashScopeConfig.isConfigured()) {
            sb.append("（万相已配置：马/房子/树/太阳/车/猫/狗/鸟等复杂主体默认 generate_and_trace）");
        } else {
            sb.append("（万相未配置：复杂主体用 draw_paths 简笔多段折线）");
        }
        if (Boolean.TRUE.equals(fineDetailMode)) {
            sb.append("\nfineDetailMode=true（万相 plus 1024 + detailed illustration 清晰线稿描摹，禁止 photorealistic）");
        }
        if (sceneContext != null && !sceneContext.isEmpty()) {
            sb.append("\n\n当前画布图形 sceneContext：\n")
                    .append(objectMapper.writeValueAsString(sceneContext));
        }
        return sb.toString();
    }

    String stripMarkdownCodeBlocks(String content) {
        if (content == null) {
            return "{}";
        }
        Matcher matcher = CODE_BLOCK_PATTERN.matcher(content.trim());
        if (matcher.find()) {
            return matcher.group(1).trim();
        }
        return content.trim();
    }

    private VoiceParseResponse parseJsonResponse(String json, boolean mockMode) throws Exception {
        JsonNode root = objectMapper.readTree(json);
        String speak = fixDrawTypo(root.path("speak").asText("好的"));
        List<DrawAction> actions = new ArrayList<>();

        JsonNode actionsNode = root.path("actions");
        if (actionsNode.isArray()) {
            for (JsonNode node : actionsNode) {
                actions.add(objectMapper.treeToValue(node, DrawAction.class));
            }
        }

        return new VoiceParseResponse(speak, actions, mockMode);
    }

    /** Correct LLM mis-routes: complex subjects → generate_and_trace when Wanx configured. */
    VoiceParseResponse enforceRouting(VoiceParseResponse response, String text,
                                      List<SceneShapeContext> sceneContext,
                                      Boolean fineDetailMode) {
        if (response == null || response.getActions() == null) {
            return response;
        }
        String normalized = text == null ? "" : text.trim();
        boolean wantWanx = shouldUseGenerateAndTrace(normalized, fineDetailMode);
        boolean hasWanx = response.getActions().stream()
                .anyMatch(a -> "generate_and_trace".equalsIgnoreCase(a.getAction()));
        boolean hasDrawPaths = response.getActions().stream()
                .anyMatch(a -> "draw_paths".equalsIgnoreCase(a.getAction()));

        if (wantWanx && !hasWanx && (hasDrawPaths || isComplexSubject(normalized))) {
            log.info("LLM returned draw_paths for complex subject; correcting to generate_and_trace");
            return mergeCorrection(response, mockParse(normalized, sceneContext, fineDetailMode));
        }
        if (!dashScopeConfig.isConfigured() && hasWanx) {
            log.info("DashScope not configured; downgrading generate_and_trace to draw_paths");
            return mergeCorrection(response, mockParse(normalized, sceneContext, fineDetailMode));
        }
        if (!wantWanx && hasWanx && isSimplePrimitiveSubject(normalized)) {
            log.info("LLM returned generate_and_trace for simple primitive; using mock draw_stroke");
            return mergeCorrection(response, mockParse(normalized, sceneContext, fineDetailMode));
        }
        return response;
    }

    private VoiceParseResponse mergeCorrection(VoiceParseResponse original, VoiceParseResponse corrected) {
        if (original.getWarning() != null) {
            corrected.setWarning(original.getWarning());
        }
        return corrected;
    }

    VoiceParseResponse mockParse(String text, List<SceneShapeContext> sceneContext,
                                 Boolean fineDetailMode) {
        String normalized = text == null ? "" : text.trim();
        List<DrawAction> actions = new ArrayList<>();
        String speak = "好的，开始执行";

        boolean hasScene = sceneContext != null && !sceneContext.isEmpty();
        boolean useWanx = shouldUseGenerateAndTrace(normalized, fineDetailMode);

        if (normalized.contains("撤销") || normalized.equalsIgnoreCase("undo")) {
            actions.add(action("undo"));
            speak = "已撤销上一步";
        } else if (normalized.contains("重做") || normalized.equalsIgnoreCase("redo")) {
            actions.add(action("redo"));
            speak = "已重做";
        } else if (normalized.contains("清空") || normalized.contains("清除")) {
            actions.add(action("clear"));
            speak = "画布已清空";
        } else if (hasScene && (normalized.contains("删除") || normalized.contains("删掉"))) {
            SceneShapeContext target = resolveTarget(normalized, sceneContext);
            if (target != null) {
                DrawAction delete = action("delete");
                delete.setTargetId(target.getId());
                actions.add(delete);
                speak = "已删除" + shapeLabel(target.getShape());
            } else {
                speak = "未找到要删除的图形";
                DrawAction miss = action("delete");
                miss.setTargetId("__not_found__");
                actions.add(miss);
            }
        } else if (hasScene && containsModifyIntent(normalized)) {
            SceneShapeContext target = resolveTarget(normalized, sceneContext);
            if (target != null) {
                DrawAction modify = action("modify");
                modify.setTargetId(target.getId());
                applyMockModify(normalized, modify, target);
                actions.add(modify);
                speak = "已修改" + shapeLabel(target.getShape());
            } else {
                speak = "未找到要修改的图形";
                DrawAction miss = action("modify");
                miss.setTargetId("__not_found__");
                actions.add(miss);
            }
        } else if (normalized.contains("圆") || normalized.contains("circle")) {
            DrawAction circle = strokeAction("circle");
            circle.setColor(extractColor(normalized));
            circle.setX(300);
            circle.setY(200);
            circle.setRadius(50);
            circle.setAnimateMs(1300);
            if (isHollowCircle(normalized)) {
                circle.setStrokeOnly(true);
                speak = "好的，开始画一个" + colorName(circle.getColor()) + "空心圆";
            } else {
                speak = "好的，开始画一个" + colorName(circle.getColor()) + "的圆";
            }
            actions.add(circle);
        } else if (normalized.contains("矩形") || normalized.contains("方块") || normalized.contains("rect")) {
            DrawAction rect = strokeAction("rect");
            rect.setColor(extractColor(normalized));
            rect.setX(250);
            rect.setY(150);
            rect.setWidth(120);
            rect.setHeight(80);
            rect.setAnimateMs(800);
            actions.add(rect);
            speak = "好的，开始画一个" + colorName(rect.getColor()) + "的矩形";
        } else if (normalized.contains("线") || normalized.contains("line")) {
            DrawAction line = strokeAction("line");
            line.setColor(extractColor(normalized));
            line.setX1(100);
            line.setY1(100);
            line.setX2(400);
            line.setY2(300);
            line.setAnimateMs(800);
            actions.add(line);
            speak = "好的，开始画一条" + colorName(line.getColor()) + "的线";
        } else if (normalized.contains("栅栏") || normalized.contains("围栏")) {
            String color = extractColor(normalized);
            int startX = 100;
            int endX = 500;
            int yTop = 150;
            int yBottom = 350;
            int count = 8;
            int step = count > 1 ? (endX - startX) / (count - 1) : 0;
            for (int i = 0; i < count; i++) {
                int x = startX + i * step;
                DrawAction fencePost = strokePathAction(color);
                fencePost.setPoints(List.of(List.of(x, yTop), List.of(x, yBottom)));
                fencePost.setAnimateMs(600);
                actions.add(fencePost);
            }
            speak = "好的，开始画栅栏";
        } else if (normalized.contains("小道") || normalized.contains("小路")) {
            String color = extractColor(normalized);
            if (hasScene && sceneContext.size() >= 2) {
                SceneShapeContext a = sceneContext.get(0);
                SceneShapeContext b = sceneContext.get(1);
                actions.add(pathBetween(a, b, color));
            } else {
                DrawAction path = strokePathAction(color);
                path.setPoints(List.of(List.of(150, 280), List.of(450, 280)));
                path.setAnimateMs(1300);
                actions.add(path);
            }
            speak = "好的，开始画一条小道";
        } else if (normalized.contains("两个房子") || normalized.contains("两座房子") || normalized.contains("两栋房子")) {
            String color = extractColor(normalized);
            actions.add(drawPathsAction(housePathItemsAt(color, 150, 200)));
            actions.add(drawPathsAction(housePathItemsAt(color, 420, 200)));
            speak = "好的，开始画两座" + colorName(color) + "房子";
        } else if (normalized.contains("猫")) {
            if (useWanx) {
                actions.add(wanxTrace("猫，侧面", normalized, fineDetailMode));
                speak = "好的，开始描绘一只猫";
            } else {
                actions.add(drawPathsAction(simpleCatPaths(extractColor(normalized))));
                speak = "好的，开始画一只猫";
            }
        } else if (normalized.contains("狗")) {
            if (useWanx) {
                actions.add(wanxTrace("狗，侧面", normalized, fineDetailMode));
                speak = "好的，开始描绘一只狗";
            } else {
                actions.add(drawPathsAction(simpleDogPaths(extractColor(normalized))));
                speak = "好的，开始画一只狗";
            }
        } else if (normalized.contains("鸟")) {
            if (useWanx) {
                actions.add(wanxTrace("鸟，站立", normalized, fineDetailMode));
                speak = "好的，开始描绘一只鸟";
            } else {
                actions.add(drawPathsAction(simpleBirdPaths(extractColor(normalized))));
                speak = "好的，开始画一只鸟";
            }
        } else if (normalized.contains("跑车") || normalized.contains("汽车")) {
            if (useWanx) {
                actions.add(wanxTrace("跑车，侧面，红色超跑", normalized, fineDetailMode));
                speak = "好的，开始描绘一辆跑车";
            } else {
                actions.add(drawPathsAction(carPathItems(extractColor(normalized))));
                speak = "好的，开始画一辆跑车";
            }
        } else if (normalized.contains("车")) {
            if (useWanx) {
                actions.add(wanxTrace("汽车，侧面", normalized, fineDetailMode));
                speak = "好的，开始描绘一辆车";
            } else {
                actions.add(drawPathsAction(carPathItems(extractColor(normalized))));
                speak = "好的，开始画一辆车";
            }
        } else if (normalized.contains("玫瑰") || normalized.contains("花")) {
            if (useWanx) {
                actions.add(wanxTrace("玫瑰花朵", normalized, fineDetailMode));
                speak = "好的，开始描绘一朵花";
            } else {
                actions.add(iconAction("mdi:flower", normalized));
                speak = "好的，开始画一朵" + colorName(extractColor(normalized)) + "花";
            }
        } else if (isStickPersonSubject(normalized)) {
            if (useWanx) {
                actions.add(wanxTrace("人物全身，火柴人风格", normalized, fineDetailMode));
                speak = "好的，开始描绘一个人";
            } else {
                actions.add(drawPathsAction(stickPersonPathItems(extractColor(normalized))));
                speak = "好的，开始画一个人";
            }
        } else if (isPortraitSubject(normalized)) {
            if (useWanx) {
                actions.add(wanxTrace("肖像头像，正面", normalized, fineDetailMode));
                speak = "好的，开始描绘头像";
            } else {
                actions.add(drawPathsAction(simpleFacePaths(extractColor(normalized))));
                speak = "好的，开始画一个简笔头像";
            }
        } else if (normalized.contains("房子") || normalized.contains("屋")) {
            if (useWanx) {
                actions.add(wanxTrace("房子，带三角屋顶", normalized, fineDetailMode));
                speak = "好的，开始描绘一座房子";
            } else {
                actions.add(drawPathsAction(housePathItems(extractColor(normalized))));
                speak = "好的，开始画一座" + colorName(extractColor(normalized)) + "房子";
            }
        } else if (normalized.contains("马")) {
            if (useWanx) {
                actions.add(wanxTrace("马，侧面轮廓", normalized, fineDetailMode));
                speak = "好的，开始描绘一匹马";
            } else {
                actions.add(drawPathsAction(horsePathItems(extractColor(normalized))));
                speak = "好的，开始画一匹马";
            }
        } else if (normalized.contains("树")) {
            if (useWanx) {
                actions.add(wanxTrace("树，有树干和树冠", normalized, fineDetailMode));
                speak = "好的，开始描绘一棵树";
            } else {
                actions.add(drawPathsAction(treePathItems(extractColor(normalized))));
                speak = "好的，开始画一棵树";
            }
        } else if (normalized.contains("太阳")) {
            if (useWanx) {
                actions.add(wanxTrace("太阳，带放射光芒", normalized, fineDetailMode));
                speak = "好的，开始描绘一个太阳";
            } else {
                actions.add(drawPathsAction(sunPathItems(extractColor(normalized))));
                speak = "好的，开始画一个" + colorName(extractColor(normalized)) + "太阳";
            }
        } else if (normalized.contains("星星") || normalized.contains("星")) {
            if (useWanx) {
                actions.add(wanxTrace("五角星", normalized, fineDetailMode));
                speak = "好的，开始描绘一颗星星";
            } else {
                actions.add(drawPathsAction(starPathItems(extractColor(normalized))));
                speak = "好的，开始画一颗" + colorName(extractColor(normalized)) + "星星";
            }
        } else if (normalized.contains("三角形") || normalized.contains("三角")) {
            actions.add(triangleDrawPath(normalized));
            speak = "好的，开始画一个" + colorName(extractColor(normalized)) + "三角形";
        } else {
            DrawAction circle = strokeAction("circle");
            circle.setColor("#3b82f6");
            circle.setX(300);
            circle.setY(200);
            circle.setRadius(40);
            actions.add(circle);
            speak = "未识别指令，已画一个默认蓝色圆作为演示";
        }

        return new VoiceParseResponse(fixDrawTypo(speak), actions, true);
    }

    private boolean containsModifyIntent(String text) {
        return text.contains("改") || text.contains("变成") || text.contains("变为")
                || text.contains("变大") || text.contains("变小")
                || text.contains("移到") || text.contains("移动");
    }

    private void applyMockModify(String text, DrawAction modify, SceneShapeContext target) {
        String color = extractColorIfPresent(text);
        if (color != null) {
            modify.setColor(color);
        }
        if (text.contains("变大")) {
            if ("circle".equals(target.getShape()) && target.getRadius() != null) {
                modify.setRadius(target.getRadius() + 20);
            } else if ("rect".equals(target.getShape())) {
                if (target.getWidth() != null) modify.setWidth(target.getWidth() + 20);
                if (target.getHeight() != null) modify.setHeight(target.getHeight() + 20);
            }
        } else if (text.contains("变小")) {
            if ("circle".equals(target.getShape()) && target.getRadius() != null) {
                modify.setRadius(Math.max(10, target.getRadius() - 20));
            } else if ("rect".equals(target.getShape())) {
                if (target.getWidth() != null) modify.setWidth(Math.max(20, target.getWidth() - 20));
                if (target.getHeight() != null) modify.setHeight(Math.max(20, target.getHeight() - 20));
            }
        }
        if (text.contains("左边") || text.contains("左移")) {
            if (target.getX() != null) modify.setX(target.getX() - 80);
        } else if (text.contains("右边") || text.contains("右移")) {
            if (target.getX() != null) modify.setX(target.getX() + 80);
        } else if (text.contains("上边") || text.contains("上移")) {
            if (target.getY() != null) modify.setY(target.getY() - 80);
        } else if (text.contains("下边") || text.contains("下移")) {
            if (target.getY() != null) modify.setY(target.getY() + 80);
        }
    }

    private SceneShapeContext resolveTarget(String text, List<SceneShapeContext> sceneContext) {
        String shapeFilter = null;
        if (text.contains("圆")) shapeFilter = "circle";
        else if (text.contains("矩形") || text.contains("方块")) shapeFilter = "rect";
        else if (text.contains("线")) shapeFilter = "line";

        List<SceneShapeContext> candidates = new ArrayList<>();
        for (SceneShapeContext shape : sceneContext) {
            if (shapeFilter == null || shapeFilter.equals(shape.getShape())) {
                candidates.add(shape);
            }
        }
        if (candidates.isEmpty()) {
            return null;
        }

        if (text.contains("第一个") || text.contains("第一")) {
            return candidates.get(0);
        }
        return candidates.get(candidates.size() - 1);
    }

    private String extractColorIfPresent(String text) {
        if (text.contains("红")) return "#ef4444";
        if (text.contains("蓝")) return "#3b82f6";
        if (text.contains("绿")) return "#22c55e";
        if (text.contains("黄")) return "#eab308";
        if (text.contains("黑")) return "#1f2937";
        if (text.contains("白")) return "#f9fafb";
        return null;
    }

    private String shapeLabel(String shape) {
        return switch (shape) {
            case "circle" -> "圆形";
            case "rect" -> "矩形";
            case "line" -> "线条";
            default -> "图形";
        };
    }

    private boolean isHollowCircle(String text) {
        return text.contains("空心") || text.contains("圆环") || text.contains("描边圆")
                || text.contains("空心圆");
    }

    private boolean wantsGenerateAndTrace(String text) {
        return text.contains("精细") || text.contains("高清") || text.contains("逼真")
                || text.contains("详细") || text.contains("写实") || text.contains("动漫高清");
    }

    private boolean isPortraitSubject(String text) {
        return text.contains("头像") || text.contains("人像") || text.contains("肖像")
                || text.contains("人脸") || text.contains("面部");
    }

    private boolean isStickPersonSubject(String text) {
        return text.contains("人") && !text.contains("个人") && !isPortraitSubject(text);
    }

    private boolean isComplexSubject(String text) {
        return text.contains("马") || text.contains("牛") || text.contains("羊")
                || text.contains("车") || text.contains("跑车") || text.contains("汽车")
                || text.contains("猫") || text.contains("狗") || text.contains("鸟")
                || text.contains("玫瑰") || text.contains("花")
                || text.contains("树") || text.contains("房子") || text.contains("屋")
                || text.contains("太阳") || text.contains("星星") || text.contains("星")
                || isStickPersonSubject(text) || isPortraitSubject(text);
    }

    private boolean isSimplePrimitiveSubject(String text) {
        if (isComplexSubject(text)) {
            return false;
        }
        return text.contains("圆") || text.contains("矩形") || text.contains("方块")
                || text.contains("线") || text.contains("三角形") || text.contains("三角")
                || text.contains("栅栏") || text.contains("围栏") || text.contains("小道")
                || text.contains("小路");
    }

    private boolean shouldUseGenerateAndTrace(String text, Boolean fineDetailMode) {
        if (!dashScopeConfig.isConfigured()) {
            return false;
        }
        if (isSimplePrimitiveSubject(text)) {
            return false;
        }
        if (isComplexSubject(text)) {
            return true;
        }
        return wantsGenerateAndTrace(text);
    }

    private static final String WANX_DETAILED_SUFFIX =
            "，high quality digital illustration，clear linework，moderate detail，soft shading allowed，"
                    + "single subject centered，NOT chibi，NOT overly simplified，"
                    + "complete full subject in frame，white background，"
                    + "高质量插画，清晰线稿，适度细节，单一主体居中，白底，非Q版";

    private static final String WANX_FLAT_CARTOON_SUFFIX =
            "，<flat illustration>，vector flat illustration，flat colors，hard edges，"
                    + "max 6 distinct flat color zones，white background，"
                    + "矢量扁平插画，纯色色块，硬边缘，白底";

    private static final String WANX_VECTOR_RETRY_SUFFIX =
            "，high quality digital illustration，clear linework，traceable line art，"
                    + "NO photograph，no photorealistic，moderate detail，white background";

    private boolean wantsFlatCartoon(String text) {
        if (text == null || text.isBlank()) {
            return false;
        }
        String lower = text.toLowerCase();
        return lower.contains("动漫") || lower.contains("卡通") || lower.contains("q版")
                || lower.contains("anime") || lower.contains("cartoon") || lower.contains("chibi");
    }

    private DrawAction wanxTrace(String subject, String text, Boolean fineDetailMode) {
        StringBuilder prompt = new StringBuilder(subject);
        if (wantsFlatCartoon(text)) {
            prompt.append(WANX_FLAT_CARTOON_SUFFIX);
        } else {
            prompt.append(WANX_DETAILED_SUFFIX);
        }
        if (Boolean.TRUE.equals(fineDetailMode) || wantsGenerateAndTrace(text)) {
            prompt.append("，detailed illustration，traceable line art，精细插画细节");
        }
        return generateAndTrace(prompt.toString());
    }

    String fixDrawTypo(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }
        return text
                .replaceAll("([来为帮])话", "$1画")
                .replace("画一话", "画一画")
                .replaceAll("话一([匹只条棵座颗个])", "画一$1");
    }

    private DrawAction drawPathsAction(List<PathItem> pathItems) {
        DrawAction action = action("draw_paths");
        action.setMode("geometry");
        action.setPathItems(pathItems);
        return action;
    }

    private PathItem pathItem(String color, List<List<Integer>> points) {
        PathItem item = new PathItem();
        item.setColor(color);
        item.setPoints(points);
        return item;
    }

    private List<PathItem> horsePathItems(String color) {
        int cx = 480;
        int cy = 300;
        return List.of(
                pathItem(color, ellipsePoints(cx, cy, 95, 42, 20)),
                pathItem(color, List.of(List.of(cx + 55, cy - 8), List.of(cx + 78, cy - 42), List.of(cx + 98, cy - 52))),
                pathItem(color, List.of(List.of(cx + 98, cy - 52), List.of(cx + 108, cy - 58), List.of(cx + 112, cy - 48))),
                pathItem(color, List.of(List.of(cx + 78, cy - 42), List.of(cx + 88, cy - 18), List.of(cx + 55, cy - 5))),
                pathItem(color, List.of(List.of(cx - 75, cy + 5), List.of(cx - 95, cy + 18), List.of(cx - 105, cy + 35))),
                pathItem(color, List.of(List.of(cx - 42, cy + 38), List.of(cx - 42, cy + 95))),
                pathItem(color, List.of(List.of(cx - 18, cy + 38), List.of(cx - 18, cy + 95))),
                pathItem(color, List.of(List.of(cx + 22, cy + 38), List.of(cx + 22, cy + 95))),
                pathItem(color, List.of(List.of(cx + 48, cy + 38), List.of(cx + 48, cy + 95))),
                pathItem(color, List.of(List.of(cx + 55, cy - 5), List.of(cx + 62, cy + 12), List.of(cx + 48, cy + 38)))
        );

    }

    private List<PathItem> carPathItems(String color) {
        String wheel = "#1f2937";
        return List.of(
                pathItem(color, List.of(List.of(180, 310), List.of(520, 310))),
                pathItem(color, List.of(List.of(180, 310), List.of(200, 275), List.of(280, 255), List.of(400, 250), List.of(490, 265), List.of(520, 295))),
                pathItem(color, List.of(List.of(280, 275), List.of(350, 255))),
                pathItem(color, List.of(List.of(380, 252), List.of(380, 295))),
                pathItem(color, List.of(List.of(410, 253), List.of(470, 260), List.of(485, 295))),
                pathItem(color, List.of(List.of(200, 295), List.of(215, 285))),
                pathItem(color, List.of(List.of(505, 295), List.of(515, 288))),
                pathItem(wheel, circlePoints(260, 310, 28, 12)),
                pathItem(wheel, circlePoints(440, 310, 28, 12)),
                pathItem(color, List.of(List.of(320, 295), List.of(360, 295)))
        );
    }

    private List<PathItem> housePathItems(String color) {
        return housePathItemsAt(color, 480, 320);
    }

    private List<PathItem> housePathItemsAt(String color, int cx, int cy) {
        int w = 100;
        int h = 70;
        int left = cx - w / 2;
        int top = cy - h / 2;
        int roofPeakY = top - 45;
        int wallTop = top + 18;
        return List.of(
                pathItem(color, List.of(
                        List.of(left, top + h), List.of(left, wallTop),
                        List.of(left + w, wallTop), List.of(left + w, top + h), List.of(left, top + h))),
                pathItem(color, List.of(
                        List.of(left, wallTop), List.of(cx, roofPeakY), List.of(left + w, wallTop))),
                pathItem(color, List.of(
                        List.of(cx - 14, top + h), List.of(cx - 14, top + h - 32),
                        List.of(cx + 14, top + h - 32), List.of(cx + 14, top + h), List.of(cx - 14, top + h)))
        );

    }

    private List<PathItem> treePathItems(String color) {
        String trunk = "#92400e";
        int cx = 480;
        return List.of(
                pathItem(trunk, List.of(List.of(cx - 5, 320), List.of(cx + 5, 380))),
                pathItem(color, List.of(List.of(cx, 320), List.of(cx - 50, 260), List.of(cx, 200),
                        List.of(cx + 50, 260), List.of(cx, 320)))
        );

    }

    private List<PathItem> sunPathItems(String color) {
        List<PathItem> items = new ArrayList<>();
        int cx = 480;
        int cy = 180;
        items.add(pathItem(color, circlePoints(cx, cy, 35, 24)));
        for (int i = 0; i < 8; i++) {
            double angle = Math.toRadians(-90 + i * 45);
            int innerR = 45;
            int outerR = 65;
            items.add(pathItem(color, List.of(
                    List.of((int) (cx + innerR * Math.cos(angle)), (int) (cy + innerR * Math.sin(angle))),
                    List.of((int) (cx + outerR * Math.cos(angle)), (int) (cy + outerR * Math.sin(angle))))));
        }
        return items;

    }

    private List<List<Integer>> circlePoints(int cx, int cy, int r, int segments) {
        List<List<Integer>> pts = new ArrayList<>();
        for (int i = 0; i <= segments; i++) {
            double angle = Math.toRadians(-90 + (360.0 * i / segments));
            pts.add(List.of((int) (cx + r * Math.cos(angle)), (int) (cy + r * Math.sin(angle))));
        }
        return pts;
    }

    private List<List<Integer>> ellipsePoints(int cx, int cy, int rx, int ry, int segments) {
        List<List<Integer>> pts = new ArrayList<>();
        for (int i = 0; i <= segments; i++) {
            double angle = Math.toRadians(-90 + (360.0 * i / segments));
            pts.add(List.of(
                    (int) (cx + rx * Math.cos(angle)),
                    (int) (cy + ry * Math.sin(angle))));
        }
        return pts;
    }

    private List<PathItem> starPathItems(String color) {
        int cx = 300;
        int cy = 200;
        int r = 50;
        List<List<Integer>> pts = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            double outerAngle = Math.toRadians(-90 + i * 72);
            double innerAngle = Math.toRadians(-90 + i * 72 + 36);
            pts.add(List.of((int) (cx + r * Math.cos(outerAngle)), (int) (cy + r * Math.sin(outerAngle))));
            pts.add(List.of((int) (cx + r * 0.4 * Math.cos(innerAngle)), (int) (cy + r * 0.4 * Math.sin(innerAngle))));
        }
        pts.add(pts.get(0));
        return List.of(pathItem(color, pts));
    }

    private List<PathItem> simpleCatPaths(String color) {
        return List.of(
                pathItem(color, List.of(List.of(280, 300), List.of(420, 300))),
                pathItem(color, List.of(List.of(350, 300), List.of(350, 240), List.of(380, 210))),
                pathItem(color, List.of(List.of(360, 210), List.of(350, 190), List.of(370, 200))),
                pathItem(color, List.of(List.of(380, 210), List.of(395, 190), List.of(390, 205))),
                pathItem(color, List.of(List.of(300, 300), List.of(300, 340))),
                pathItem(color, List.of(List.of(400, 300), List.of(400, 340)))
        );
    }

    private List<PathItem> simpleDogPaths(String color) {
        return List.of(
                pathItem(color, List.of(List.of(260, 300), List.of(440, 300))),
                pathItem(color, List.of(List.of(440, 300), List.of(480, 260), List.of(500, 270))),
                pathItem(color, List.of(List.of(320, 300), List.of(320, 230), List.of(360, 210))),
                pathItem(color, List.of(List.of(280, 300), List.of(280, 350))),
                pathItem(color, List.of(List.of(400, 300), List.of(400, 350)))
        );
    }

    private List<PathItem> simpleBirdPaths(String color) {
        int cx = 480;
        int cy = 280;
        return List.of(
                pathItem(color, List.of(List.of(cx - 40, cy), List.of(cx + 40, cy))),
                pathItem(color, List.of(List.of(cx - 40, cy), List.of(cx - 55, cy - 25), List.of(cx - 20, cy - 15))),
                pathItem(color, List.of(List.of(cx + 40, cy), List.of(cx + 55, cy - 25), List.of(cx + 20, cy - 15))),
                pathItem(color, List.of(List.of(cx, cy), List.of(cx, cy + 35))),
                pathItem(color, List.of(List.of(cx - 8, cy + 35), List.of(cx - 8, cy + 55))),
                pathItem(color, List.of(List.of(cx + 8, cy + 35), List.of(cx + 8, cy + 55)))
        );
    }

    private List<PathItem> simpleFacePaths(String color) {
        return List.of(
                pathItem(color, ellipsePoints(480, 300, 72, 88, 28)),
                pathItem(color, circlePoints(452, 282, 7, 10)),
                pathItem(color, circlePoints(508, 282, 7, 10)),
                pathItem(color, List.of(
                        List.of(448, 325), List.of(464, 335), List.of(480, 338),
                        List.of(496, 335), List.of(512, 325)))
        );

    }

    private List<PathItem> stickPersonPathItems(String color) {
        int cx = 480;
        int headY = 220;
        int neckY = headY + 28;
        int hipY = 360;
        return List.of(
                pathItem(color, circlePoints(cx, headY, 26, 18)),
                pathItem(color, circlePoints(cx - 10, headY - 4, 4, 8)),
                pathItem(color, circlePoints(cx + 10, headY - 4, 4, 8)),
                pathItem(color, List.of(
                        List.of(cx - 12, headY + 8), List.of(cx - 4, headY + 12), List.of(cx + 4, headY + 12), List.of(cx + 12, headY + 8))),
                pathItem(color, List.of(List.of(cx, neckY), List.of(cx, hipY))),
                pathItem(color, List.of(List.of(cx, neckY + 25), List.of(cx - 55, neckY + 55))),
                pathItem(color, List.of(List.of(cx, neckY + 25), List.of(cx + 55, neckY + 55))),
                pathItem(color, List.of(List.of(cx, hipY), List.of(cx - 35, hipY + 75))),
                pathItem(color, List.of(List.of(cx, hipY), List.of(cx + 35, hipY + 75)))
        );
    }


    private DrawAction action(String type) {
        DrawAction action = new DrawAction();
        action.setAction(type);
        return action;
    }

    private DrawAction strokeAction(String shape) {
        DrawAction action = action("draw_stroke");
        action.setMode("geometry");
        action.setShape(shape);
        return action;
    }

    private DrawAction strokePathAction(String color) {
        DrawAction path = action("draw_stroke");
        path.setMode("geometry");
        path.setColor(color);
        return path;
    }

    private DrawAction generateAndTrace(String imagePrompt) {
        DrawAction trace = action("generate_and_trace");
        trace.setMode("picture");
        trace.setImagePrompt(imagePrompt);
        trace.setAnimateMs(600);
        return trace;
    }

    private DrawAction houseStrokeAction(String text, int cx, int cy, String color) {
        int w = 80;
        int h = 60;
        int left = cx - w / 2;
        int top = cy - h / 2;
        DrawAction house = strokePathAction(color);
        house.setPoints(List.of(
                List.of(left, top + h / 3),
                List.of(cx, top - h / 3),
                List.of(left + w, top + h / 3),
                List.of(left + w, top + h),
                List.of(left, top + h),
                List.of(left, top + h / 3)
        ));
        house.setClosed(true);
        house.setAnimateMs(900);
        return house;
    }

    private DrawAction starStrokeAction(String text, int cx, int cy, String color, int r) {
        List<List<Integer>> pts = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            double outerAngle = Math.toRadians(-90 + i * 72);
            double innerAngle = Math.toRadians(-90 + i * 72 + 36);
            pts.add(List.of((int) (cx + r * Math.cos(outerAngle)), (int) (cy + r * Math.sin(outerAngle))));
            pts.add(List.of((int) (cx + r * 0.4 * Math.cos(innerAngle)), (int) (cy + r * 0.4 * Math.sin(innerAngle))));
        }
        pts.add(pts.get(0));
        DrawAction star = strokePathAction(color);
        star.setPoints(pts);
        star.setClosed(true);
        star.setAnimateMs(1000);
        return star;
    }

    private DrawAction iconAction(String iconId, String text) {
        return iconAction(iconId, text,
                text.contains("左上") || text.contains("左上角") ? 80 : 300,
                text.contains("左上") || text.contains("左上角") ? 60 : 200,
                extractColor(text));
    }

    private DrawAction iconAction(String iconId, String text, int x, int y, String color) {
        DrawAction icon = action("useIcon");
        icon.setIconId(iconId);
        icon.setColor(color);
        icon.setX(x);
        icon.setY(y);
        icon.setScale(1.0);
        icon.setAnimateMs(800);
        return icon;
    }

    private DrawAction pathBetween(SceneShapeContext a, SceneShapeContext b, String color) {
        int ax = centerX(a);
        int ay = centerY(a);
        int bx = centerX(b);
        int by = centerY(b);
        DrawAction path = strokePathAction(color);
        path.setPoints(List.of(List.of(ax, ay), List.of(bx, by)));
        path.setAnimateMs(1300);
        return path;
    }

    private int centerX(SceneShapeContext shape) {
        if (shape.getX() == null) return 300;
        if ("rect".equals(shape.getShape()) && shape.getWidth() != null) {
            return shape.getX() + shape.getWidth() / 2;
        }
        return shape.getX();
    }

    private int centerY(SceneShapeContext shape) {
        if (shape.getY() == null) return 200;
        if ("rect".equals(shape.getShape()) && shape.getHeight() != null) {
            return shape.getY() + shape.getHeight() / 2;
        }
        if ("circle".equals(shape.getShape()) && shape.getRadius() != null) {
            return shape.getY();
        }
        return shape.getY();
    }

    private DrawAction templateAction(String templateId, String text) {
        DrawAction tpl = action("useTemplate");
        tpl.setTemplateId(templateId);
        tpl.setColor(extractColor(text));
        tpl.setX(text.contains("左上") || text.contains("左上角") ? 80 : 300);
        tpl.setY(text.contains("左上") || text.contains("左上角") ? 60 : 200);
        tpl.setScale(1.0);
        tpl.setAnimateMs(800);
        return tpl;
    }

    private DrawAction triangleDrawPath(String text) {
        DrawAction path = strokePathAction(extractColor(text));
        int cx = text.contains("左上") || text.contains("左上角") ? 130 : 300;
        int cy = text.contains("左上") || text.contains("左上角") ? 130 : 200;
        int size = 60;
        path.setPoints(List.of(
                List.of(cx, cy - size),
                List.of(cx - size, cy + size / 2),
                List.of(cx + size, cy + size / 2),
                List.of(cx, cy - size)
        ));
        path.setClosed(true);
        path.setAnimateMs(1300);
        return path;
    }

    private String extractColor(String text) {
        if (text.contains("红")) return "#ef4444";
        if (text.contains("蓝")) return "#3b82f6";
        if (text.contains("绿")) return "#22c55e";
        if (text.contains("黄")) return "#eab308";
        if (text.contains("黑")) return "#1f2937";
        if (text.contains("白")) return "#f9fafb";
        return "#6366f1";
    }

    private String colorName(String hex) {
        return switch (hex) {
            case "#ef4444" -> "红色";
            case "#3b82f6" -> "蓝色";
            case "#22c55e" -> "绿色";
            case "#eab308" -> "黄色";
            case "#1f2937" -> "黑色";
            case "#f9fafb" -> "白色";
            default -> "";
        };
    }
}
