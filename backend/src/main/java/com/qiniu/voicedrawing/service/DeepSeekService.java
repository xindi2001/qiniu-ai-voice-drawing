package com.qiniu.voicedrawing.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.qiniu.voicedrawing.config.DeepSeekConfig;
import com.qiniu.voicedrawing.dto.DrawAction;
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
              "speak": "简短中文回复，用于语音播报",
              "actions": [
                {
                  "action": "draw|modify|delete|undo|redo|clear",
                  "shape": "circle|rect|line",
                  "color": "#ff0000",
                  "x": 200, "y": 150,
                  "width": 100, "height": 80,
                  "radius": 50,
                  "x1": 50, "y1": 50, "x2": 200, "y2": 200,
                  "targetId": "可选，修改/删除目标图形的 id"
                }
              ]
            }
            规则：
            - draw 画图形，需提供 shape 和位置尺寸
            - 颜色用十六进制，如红色 #ff0000、蓝色 #0000ff、绿色 #00ff00
            - 未指定位置时居中：x=300, y=200
            - undo/redo/clear 只需 action 字段
            - 支持组合指令，多个 action 按顺序执行
            - 用户消息中会附带当前画布图形列表 sceneContext（含 id、shape、color、坐标等）
            - 引用已有图形时，modify/delete 必须使用 sceneContext 中的 id 作为 targetId
            - 「上一个」「最后一个」「那个圆」等指代：默认指列表中最后一项；按形状描述则找最后一个匹配 shape
            - modify 可修改 color、x、y、width、height、radius 等字段，只传需要变更的字段
            - 「变大一点」：circle 的 radius +20，rect 的 width/height 各 +20
            - 「移到左边」：x 减少约 80；「移到右边」：x 增加约 80
            """;

    private static final Pattern CODE_BLOCK_PATTERN =
            Pattern.compile("```(?:json)?\\s*([\\s\\S]*?)```", Pattern.CASE_INSENSITIVE);

    private final DeepSeekConfig deepSeekConfig;
    private final ObjectMapper objectMapper;
    private final RestTemplate restTemplate;

    public DeepSeekService(DeepSeekConfig deepSeekConfig, ObjectMapper objectMapper) {
        this.deepSeekConfig = deepSeekConfig;
        this.objectMapper = objectMapper;
        this.restTemplate = new RestTemplate();
    }

    public VoiceParseResponse parseCommand(String text, List<SceneShapeContext> sceneContext) {
        if (!deepSeekConfig.isConfigured()) {
            log.info("DeepSeek API key not configured, using mock mode");
            return mockParse(text, sceneContext);
        }

        try {
            String content = callDeepSeekApi(text, sceneContext);
            String json = stripMarkdownCodeBlocks(content);
            return parseJsonResponse(json, false);
        } catch (RestClientResponseException e) {
            int status = e.getStatusCode().value();
            if (status == 401 || status == 403) {
                log.warn("Invalid DeepSeek API key (HTTP {}), falling back to mock mode", status);
            } else {
                log.warn("DeepSeek API returned HTTP {} ({}), falling back to mock mode",
                        status, e.getStatusText());
            }
            return mockParse(text, sceneContext);
        } catch (Exception e) {
            log.warn("DeepSeek API call failed, falling back to mock: {}", e.getMessage());
            return mockWithWarning(text, sceneContext,
                    "DeepSeek API 不可用，已降级为 Mock 模式: " + e.getMessage());
        }
    }

    private VoiceParseResponse mockWithWarning(String text, List<SceneShapeContext> sceneContext,
                                               String warning) {
        VoiceParseResponse response = mockParse(text, sceneContext);
        response.setWarning(warning);
        return response;
    }

    private String callDeepSeekApi(String text, List<SceneShapeContext> sceneContext) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(deepSeekConfig.getApiKey());

        String userContent = buildUserMessage(text, sceneContext);

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

    private String buildUserMessage(String text, List<SceneShapeContext> sceneContext) throws Exception {
        if (sceneContext == null || sceneContext.isEmpty()) {
            return text;
        }
        String contextJson = objectMapper.writeValueAsString(sceneContext);
        return "用户指令：" + text + "\n\n当前画布图形 sceneContext：\n" + contextJson;
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
        String speak = root.path("speak").asText("好的");
        List<DrawAction> actions = new ArrayList<>();

        JsonNode actionsNode = root.path("actions");
        if (actionsNode.isArray()) {
            for (JsonNode node : actionsNode) {
                actions.add(objectMapper.treeToValue(node, DrawAction.class));
            }
        }

        return new VoiceParseResponse(speak, actions, mockMode);
    }

    VoiceParseResponse mockParse(String text, List<SceneShapeContext> sceneContext) {
        String normalized = text == null ? "" : text.trim();
        List<DrawAction> actions = new ArrayList<>();
        String speak = "好的，已执行";

        boolean hasScene = sceneContext != null && !sceneContext.isEmpty();

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
            DrawAction circle = action("draw");
            circle.setShape("circle");
            circle.setColor(extractColor(normalized));
            circle.setX(300);
            circle.setY(200);
            circle.setRadius(50);
            actions.add(circle);
            speak = "已画一个" + colorName(circle.getColor()) + "的圆";
        } else if (normalized.contains("矩形") || normalized.contains("方块") || normalized.contains("rect")) {
            DrawAction rect = action("draw");
            rect.setShape("rect");
            rect.setColor(extractColor(normalized));
            rect.setX(250);
            rect.setY(150);
            rect.setWidth(120);
            rect.setHeight(80);
            actions.add(rect);
            speak = "已画一个" + colorName(rect.getColor()) + "的矩形";
        } else if (normalized.contains("线") || normalized.contains("line")) {
            DrawAction line = action("draw");
            line.setShape("line");
            line.setColor(extractColor(normalized));
            line.setX1(100);
            line.setY1(100);
            line.setX2(400);
            line.setY2(300);
            actions.add(line);
            speak = "已画一条" + colorName(line.getColor()) + "的线";
        } else {
            DrawAction circle = action("draw");
            circle.setShape("circle");
            circle.setColor("#3b82f6");
            circle.setX(300);
            circle.setY(200);
            circle.setRadius(40);
            actions.add(circle);
            speak = "未识别指令，已画一个默认蓝色圆作为演示";
        }

        return new VoiceParseResponse(speak, actions, true);
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

    private DrawAction action(String type) {
        DrawAction action = new DrawAction();
        action.setAction(type);
        return action;
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
