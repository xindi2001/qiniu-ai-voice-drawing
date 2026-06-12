package com.qiniu.voicedrawing.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.qiniu.voicedrawing.config.DeepSeekConfig;
import com.qiniu.voicedrawing.dto.DrawAction;
import com.qiniu.voicedrawing.dto.VoiceParseResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
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
                  "targetId": "可选，修改/删除目标"
                }
              ]
            }
            规则：
            - draw 画图形，需提供 shape 和位置尺寸
            - 颜色用十六进制，如红色 #ff0000、蓝色 #0000ff、绿色 #00ff00
            - 未指定位置时居中：x=300, y=200
            - undo/redo/clear 只需 action 字段
            - 支持组合指令，多个 action 按顺序执行
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

    public VoiceParseResponse parseCommand(String text) {
        if (!deepSeekConfig.isConfigured()) {
            log.info("DeepSeek API key not configured, using mock mode");
            return mockParse(text);
        }

        try {
            String content = callDeepSeekApi(text);
            String json = stripMarkdownCodeBlocks(content);
            return parseJsonResponse(json, false);
        } catch (Exception e) {
            log.warn("DeepSeek API call failed, falling back to mock: {}", e.getMessage());
            return mockParse(text);
        }
    }

    private String callDeepSeekApi(String text) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(deepSeekConfig.getApiKey());

        Map<String, Object> body = new HashMap<>();
        body.put("model", deepSeekConfig.getModel());
        body.put("temperature", 0.2);
        body.put("messages", List.of(
                Map.of("role", "system", "content", SYSTEM_PROMPT),
                Map.of("role", "user", "content", text)
        ));

        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);
        ResponseEntity<String> response = restTemplate.postForEntity(
                deepSeekConfig.getApiUrl(), entity, String.class);

        JsonNode root = objectMapper.readTree(response.getBody());
        return root.path("choices").path(0).path("message").path("content").asText();
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

    VoiceParseResponse mockParse(String text) {
        String normalized = text == null ? "" : text.trim();
        List<DrawAction> actions = new ArrayList<>();
        String speak = "好的，已执行";

        if (normalized.contains("撤销") || normalized.equalsIgnoreCase("undo")) {
            actions.add(action("undo"));
            speak = "已撤销上一步";
        } else if (normalized.contains("重做") || normalized.equalsIgnoreCase("redo")) {
            actions.add(action("redo"));
            speak = "已重做";
        } else if (normalized.contains("清空") || normalized.contains("清除")) {
            actions.add(action("clear"));
            speak = "画布已清空";
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
