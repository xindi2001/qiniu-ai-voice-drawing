package com.qiniu.voicedrawing.service;



import com.fasterxml.jackson.databind.JsonNode;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.qiniu.voicedrawing.config.DashScopeConfig;

import com.qiniu.voicedrawing.dto.ImageGenerateResponse;

import org.slf4j.Logger;

import org.slf4j.LoggerFactory;

import org.springframework.http.HttpEntity;

import org.springframework.http.HttpHeaders;

import org.springframework.http.HttpMethod;

import org.springframework.http.MediaType;

import org.springframework.http.ResponseEntity;

import org.springframework.http.client.SimpleClientHttpRequestFactory;

import org.springframework.stereotype.Service;



import org.springframework.web.client.RestTemplate;

import java.net.http.HttpClient;

import java.net.http.HttpRequest;

import java.net.http.HttpResponse;

import java.time.Duration;

import java.net.URI;

import java.util.Base64;

import java.util.HashMap;

import java.util.Map;



@Service

public class WanxImageService {



    private static final Logger log = LoggerFactory.getLogger(WanxImageService.class);

    private static final int MAX_POLL_ATTEMPTS = 40;

    private static final long INITIAL_POLL_MS = 500;

    private static final long MAX_POLL_MS = 2000;

    private static final String MODEL_TURBO = "wanx2.1-t2i-turbo";
    private static final String MODEL_PLUS = "wanx2.1-t2i-plus";



    /** Default detailed illustration — clear linework, moderate detail, NOT chibi. */
    private static final String DEFAULT_ILLUSTRATION_PROMPT =
            "high quality digital illustration, clear linework, moderate detail, soft shading allowed, "
                    + "single subject centered, single view, NOT chibi, NOT overly simplified, "
                    + "complete full subject in frame, white background, "
                    + "高质量数字插画，清晰线稿，适度细节，柔和阴影，单一主体居中，白底，非Q版";

    private static final String DETAILED_ILLUSTRATION_SUFFIX =
            "，high quality digital illustration，clear linework，moderate detail，soft shading allowed，"
                    + "single subject centered，single view，NOT chibi，NOT overly simplified，"
                    + "complete full subject in frame，white background，"
                    + "高质量数字插画，清晰线稿，适度细节，单一主体居中，白底，非Q版";

    /** Flat cartoon — only when user explicitly requests anime/cartoon style. */
    private static final String FLAT_CARTOON_SUFFIX =
            "，<flat illustration>，vector flat illustration，ONE subject only，centered，single view，"
                    + "max 6 distinct flat color zones，each zone solid color，hard edges，"
                    + "distinct flat color blocks，no gradient，no internal shading，white background，"
                    + "矢量扁平插画，仅单一主体居中，最多6种纯色色块，硬边缘，白底";

    private static final String OUTLINE_ONLY_SUFFIX =
            "，ONE subject only，centered，single view，complete full subject in frame NOT cropped，"
                    + "flat color illustration with clear distinct edges，hard edges between color zones，"
                    + "clean line art style easy to trace，clear body silhouette，"
                    + "NO hatch，NO cross-hatch，NO woodcut shading，NO parallel shading strokes，"
                    + "white background，solid flat colors，"
                    + "仅单一主体居中，完整入画，清晰硬边缘，扁平色块，易描摹线稿，白底";

    private static final String OUTLINE_ONLY_VEHICLE_SUFFIX =
            "，ONE vehicle only，centered，side or 3/4 view，full car in frame wheels windows included NOT cropped，"
                    + "flat color sports car illustration，clear body outline，distinct panel lines，"
                    + "hard edges between body hood doors roof wheels，clean silhouette，"
                    + "NO hatch，NO cross-hatch，NO reflection stripes，NO parallel shading lines，"
                    + "white background，solid flat colors，"
                    + "仅一辆汽车居中，完整车身入画含车轮车窗，清晰轮廓与面板线，硬边缘，白底";

    /** @deprecated flat cartoon sketch suffix — use style detection instead */
    private static final String SKETCH_THEN_COLOR_FLAT_SUFFIX =
            "，ONE subject only，centered，exactly 6 flat color zones，each zone solid color，"
                    + "clear silhouette，digital illustration，hard edges，white background，"
                    + "仅单一主体居中，6个纯色色块，清晰轮廓，硬边缘，白底";

    private static final String NEGATIVE_PROMPT =
            "photograph，photorealistic，realistic photo，3d render，3D render，gradient，soft shadow，reflection，"
                    + "studio lighting，blur，bokeh，untraceable，continuous tone，"
                    + "cropped，partial view，texture noise，cross-hatch，hatching，woodcut，engraving，"
                    + "parallel lines，scan lines，topographic lines，stipple shading，"
                    + "低质量，模糊，噪点，水印，文字，logo，变形，多余肢体，残缺，"
                    + "extra characters，extra people，driver，passenger，crowd，"
                    + "cluttered background，busy scene，cropped subject，multiple unrelated subjects，"
                    + "watermark，text，deformed，extra limbs，bad anatomy，lowres，random person，composite scene";



    private final DashScopeConfig dashScopeConfig;

    private final ObjectMapper objectMapper;

    private final RestTemplate restTemplate;

    private final HttpClient httpClient;



    public WanxImageService(DashScopeConfig dashScopeConfig, ObjectMapper objectMapper) {

        this.dashScopeConfig = dashScopeConfig;

        this.objectMapper = objectMapper;

        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10_000);
        factory.setReadTimeout(15_000);
        this.restTemplate = new RestTemplate(factory);

        this.httpClient = HttpClient.newBuilder()

                .followRedirects(HttpClient.Redirect.NORMAL)

                .connectTimeout(Duration.ofSeconds(30))

                .build();

    }



    public boolean isConfigured() {

        return dashScopeConfig.isConfigured();

    }



    public ImageGenerateResponse generate(String prompt) {

        return generate(prompt, false);

    }



    public ImageGenerateResponse generate(String prompt, boolean fineDetail) {
        return generate(prompt, fineDetail, null);
    }

    public ImageGenerateResponse generate(String prompt, boolean fineDetail, String drawMode) {

        if (!dashScopeConfig.isConfigured()) {

            throw new IllegalStateException(

                    "通义万相未配置：请设置环境变量 DASHSCOPE_API_KEY 后重启后端");

        }



        long t0 = System.currentTimeMillis();
        String model = resolveModel(fineDetail, prompt, drawMode);
        String size = resolveImageSize(prompt, fineDetail);

        try {

            String taskId = submitTask(prompt, fineDetail, drawMode);

            JsonNode result = pollTask(taskId);

            String imageUrl = extractImageUrl(result);

            if (imageUrl == null || imageUrl.isBlank()) {

                throw new IllegalStateException("通义万相未返回图片 URL");

            }

            long elapsed = System.currentTimeMillis() - t0;
            log.info("[wanx] generated in {}ms model={} size={}", elapsed, model, size);

            return buildResponseWithOptionalDownload(imageUrl);

        } catch (IllegalStateException e) {

            throw e;

        } catch (Exception e) {

            log.error("Wanx image generation failed", e);

            throw new IllegalStateException("通义万相生图失败: " + e.getMessage(), e);

        }

    }



    private String submitTask(String prompt, boolean fineDetail, String drawMode) throws Exception {

        HttpHeaders headers = new HttpHeaders();

        headers.setContentType(MediaType.APPLICATION_JSON);

        headers.setBearerAuth(dashScopeConfig.getApiKey());

        headers.set("X-DashScope-Async", "enable");



        String enhancedPrompt = enhanceIllustrationPrompt(prompt, fineDetail, drawMode);

        Map<String, Object> input = new HashMap<>();

        input.put("prompt", enhancedPrompt);

        input.put("negative_prompt", NEGATIVE_PROMPT);



        Map<String, Object> parameters = new HashMap<>();

        parameters.put("size", resolveImageSize(prompt, fineDetail));

        parameters.put("n", 1);

        String style = dashScopeConfig.getStyle();

        if (style != null && !style.isBlank()) {

            parameters.put("style", style);

        }



        String model = resolveModel(fineDetail, prompt, drawMode);

        Map<String, Object> body = new HashMap<>();

        body.put("model", model);

        body.put("input", input);

        body.put("parameters", parameters);



        log.info("Wanx submit: model={} size={} fineDetail={}",

                model, resolveImageSize(prompt, fineDetail), fineDetail);



        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);

        ResponseEntity<String> response = restTemplate.postForEntity(

                dashScopeConfig.imageSynthesisUrl(), entity, String.class);



        JsonNode root = objectMapper.readTree(response.getBody());

        String taskId = root.path("output").path("task_id").asText(null);

        if (taskId == null || taskId.isBlank()) {

            throw new IllegalStateException("通义万相任务创建失败: " + root);

        }

        log.info("Wanx task submitted: {}", taskId);

        return taskId;

    }



    private String resolveModel(boolean fineDetail, String prompt, String drawMode) {

        boolean outlineMode = drawMode != null
                && ("outline_only".equalsIgnoreCase(drawMode.trim())
                || "sketch_then_color".equalsIgnoreCase(drawMode.trim()));

        if (outlineMode) {

            if (fineDetail && wantsHighDetailPrompt(prompt)) {

                return MODEL_PLUS;

            }

            String configured = dashScopeConfig.getModel();

            if (configured != null && !configured.isBlank()) {

                return configured;

            }

            return MODEL_TURBO;

        }

        if (fineDetail) {

            return MODEL_PLUS;

        }

        String configured = dashScopeConfig.getModel();

        if (configured != null && !configured.isBlank()) {

            return configured;

        }

        return MODEL_TURBO;

    }



    private boolean wantsHighDetailPrompt(String prompt) {

        if (prompt == null || prompt.isBlank()) {

            return false;

        }

        String lower = prompt.toLowerCase();

        return prompt.contains("精细") || prompt.contains("高清") || prompt.contains("高分辨率")

                || lower.contains("high detail") || lower.contains("high resolution")

                || lower.contains(" hd ") || lower.endsWith(" hd");

    }



    private boolean isLandscapePrompt(String prompt) {

        if (prompt == null || prompt.isBlank()) {

            return false;

        }

        String lower = prompt.toLowerCase();

        return prompt.contains("横图") || prompt.contains("风景") || prompt.contains("宽屏")

                || lower.contains("landscape") || lower.contains("wide") || lower.contains("panorama");

    }



    private String resolveImageSize(String prompt, boolean fineDetail) {

        if (fineDetail) {

            return isLandscapePrompt(prompt) ? "1024*768" : "1024*1024";

        }

        String configured = dashScopeConfig.getImageSize();

        if (configured != null && !configured.isBlank()) {

            return configured;

        }

        return isLandscapePrompt(prompt) ? "768*512" : "768*768";

    }



    private JsonNode pollTask(String taskId) throws Exception {

        HttpHeaders headers = new HttpHeaders();

        headers.setBearerAuth(dashScopeConfig.getApiKey());

        HttpEntity<Void> entity = new HttpEntity<>(headers);



        long waitMs = INITIAL_POLL_MS;

        for (int attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {

            if (attempt > 0) {

                Thread.sleep(waitMs);

                waitMs = Math.min(waitMs + 250, MAX_POLL_MS);

            }



            ResponseEntity<String> response = restTemplate.exchange(

                    dashScopeConfig.taskUrl(taskId),

                    HttpMethod.GET,

                    entity,

                    String.class);



            JsonNode root = objectMapper.readTree(response.getBody());

            JsonNode output = root.path("output");

            String status = output.path("task_status").asText("UNKNOWN");

            log.debug("Wanx task {} status: {}", taskId, status);



            if ("SUCCEEDED".equalsIgnoreCase(status)) {

                return output;

            }

            if ("FAILED".equalsIgnoreCase(status) || "CANCELLED".equalsIgnoreCase(status)) {

                String message = output.path("message").asText("任务失败");

                throw new IllegalStateException("通义万相生图任务失败: " + message);

            }

        }

        throw new IllegalStateException("通义万相生图超时，请稍后重试");

    }



    private ImageGenerateResponse buildResponseWithOptionalDownload(String imageUrl) {

        try {

            byte[] imageBytes = downloadImage(imageUrl);

            if (imageBytes != null && imageBytes.length > 0) {

                String base64 = Base64.getEncoder().encodeToString(imageBytes);

                return new ImageGenerateResponse(imageUrl, base64, "image/png");

            }

            log.warn("Wanx image download returned empty body, returning URL only");

        } catch (Exception e) {

            log.warn("Failed to download Wanx image from OSS, returning URL only: {}", e.getMessage());

        }

        return new ImageGenerateResponse(imageUrl, null, "image/png");

    }



    private byte[] downloadImage(String imageUrl) throws Exception {

        HttpRequest request = HttpRequest.newBuilder(URI.create(imageUrl))

                .GET()

                .timeout(Duration.ofSeconds(60))

                .build();

        HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());

        int status = response.statusCode();

        if (status >= 200 && status < 300) {

            return response.body();

        }

        throw new IllegalStateException("OSS download HTTP " + status);

    }



    private String extractImageUrl(JsonNode output) {

        JsonNode results = output.path("results");

        if (results.isArray() && !results.isEmpty()) {

            return results.get(0).path("url").asText(null);

        }



        JsonNode choices = output.path("choices");

        if (choices.isArray() && !choices.isEmpty()) {

            JsonNode content = choices.get(0).path("message").path("content");

            if (content.isArray()) {

                for (JsonNode item : content) {

                    if (item.has("image")) {

                        return item.path("image").asText(null);

                    }

                }

            }

        }

        return null;

    }



    private enum WanxStyle {
        FLAT_CARTOON,
        DETAILED_ILLUSTRATION
    }

    private WanxStyle detectWanxStyle(String prompt) {
        if (prompt == null || prompt.isBlank()) {
            return WanxStyle.DETAILED_ILLUSTRATION;
        }
        String lower = prompt.toLowerCase();
        String[] cartoonHints = {
                "动漫", "卡通", "q版", "anime", "cartoon", "chibi", "flat cartoon", "扁平卡通", "cel-shading"
        };
        for (String hint : cartoonHints) {
            if (lower.contains(hint.toLowerCase())) {
                return WanxStyle.FLAT_CARTOON;
            }
        }
        return WanxStyle.DETAILED_ILLUSTRATION;
    }

    private boolean isVehiclePrompt(String prompt) {
        if (prompt == null || prompt.isBlank()) {
            return false;
        }
        String lower = prompt.toLowerCase();
        String[] vehicleHints = {
                "车", "汽车", "跑车", "轿车", "卡车", "公交", "car", "vehicle", "truck", "bus", "suv", "sedan"
        };
        for (String hint : vehicleHints) {
            if (lower.contains(hint.toLowerCase())) {
                return true;
            }
        }
        return false;
    }

    private String enhanceIllustrationPrompt(String prompt, boolean fineDetail, String drawMode) {
        if (prompt == null || prompt.isBlank()) {
            return DEFAULT_ILLUSTRATION_PROMPT;
        }
        String trimmed = prompt.trim();
        WanxStyle style = detectWanxStyle(trimmed);
        StringBuilder sb = new StringBuilder(trimmed);

        boolean outlineMode = drawMode != null
                && ("outline_only".equalsIgnoreCase(drawMode.trim())
                || "sketch_then_color".equalsIgnoreCase(drawMode.trim()));
        if (outlineMode) {
            if (style == WanxStyle.FLAT_CARTOON) {
                if (!sb.toString().contains("flat vector cartoon")) {
                    sb.append(SKETCH_THEN_COLOR_FLAT_SUFFIX);
                }
            } else if (isVehiclePrompt(trimmed)) {
                if (!sb.toString().contains("flat color sports car")) {
                    sb.append(OUTLINE_ONLY_VEHICLE_SUFFIX);
                }
            } else if (!sb.toString().contains("easy to trace")) {
                sb.append(OUTLINE_ONLY_SUFFIX);
            }
        } else if (style == WanxStyle.FLAT_CARTOON) {
            if (!sb.toString().contains("<flat illustration>")) {
                sb.append(FLAT_CARTOON_SUFFIX);
            }
        } else {
            boolean hasIllustrationHint = trimmed.contains("插画")
                    || trimmed.contains("illustration")
                    || trimmed.contains("reference")
                    || trimmed.contains("参考")
                    || trimmed.contains("line art")
                    || trimmed.contains("线稿");
            if (!hasIllustrationHint) {
                sb.append(DETAILED_ILLUSTRATION_SUFFIX);
            }
        }

        if (fineDetail && !sb.toString().contains("traceable line art")) {
            sb.append("，traceable line art，detailed illustration with clear edges，可描摹线稿，清晰边缘");
        }
        return sb.toString();
    }
}


