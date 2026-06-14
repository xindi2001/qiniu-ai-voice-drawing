package com.qiniu.voicedrawing.controller;

import com.qiniu.voicedrawing.dto.ImageGenerateRequest;
import com.qiniu.voicedrawing.dto.ImageGenerateResponse;
import com.qiniu.voicedrawing.service.WanxImageService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/v1/voice")
public class ImageGenController {

    private final WanxImageService wanxImageService;

    public ImageGenController(WanxImageService wanxImageService) {
        this.wanxImageService = wanxImageService;
    }

    @GetMapping("/image-gen/status")
    public Map<String, Object> status() {
        boolean configured = wanxImageService.isConfigured();
        return Map.of(
                "dashscopeConfigured", configured,
                "message", configured
                        ? "通义万相已配置，复杂物体（马/房子/树等）默认 generate_and_trace"
                        : "未配置 DASHSCOPE_API_KEY，复杂物体使用 draw_paths 简笔模板"
        );
    }

    @PostMapping("/generate-image")
    public ResponseEntity<?> generateImage(@Valid @RequestBody ImageGenerateRequest request) {
        if (!wanxImageService.isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                    "error", "通义万相未配置：请设置 DASHSCOPE_API_KEY 环境变量后重启后端",
                    "configured", false
            ));
        }

        ImageGenerateResponse response = wanxImageService.generate(
                request.getPrompt(), Boolean.TRUE.equals(request.getFineDetail()), request.getDrawMode());
        return ResponseEntity.ok(response);
    }
}
