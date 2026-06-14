package com.qiniu.voicedrawing.controller;

import com.qiniu.voicedrawing.config.AliyunAsrConfig;
import com.qiniu.voicedrawing.dto.AsrStatusResponse;
import com.qiniu.voicedrawing.dto.VoiceTranscribeResponse;
import com.qiniu.voicedrawing.service.AliyunAsrService;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.Base64;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/voice")
public class VoiceTranscribeController {

    private final AliyunAsrConfig aliyunAsrConfig;
    private final AliyunAsrService aliyunAsrService;

    public VoiceTranscribeController(AliyunAsrConfig aliyunAsrConfig, AliyunAsrService aliyunAsrService) {
        this.aliyunAsrConfig = aliyunAsrConfig;
        this.aliyunAsrService = aliyunAsrService;
    }

    @GetMapping("/asr/status")
    public AsrStatusResponse asrStatus() {
        if (aliyunAsrConfig.isConfigured()) {
            return new AsrStatusResponse(
                    true,
                    "aliyun",
                    "阿里云 ASR 已配置，前端将优先使用服务端语音识别");
        }
        return new AsrStatusResponse(
                false,
                "webspeech",
                "阿里云 ASR 未配置（需 ALIYUN_ACCESS_KEY_ID、ALIYUN_ACCESS_KEY_SECRET、ALIYUN_ASR_APP_KEY），将使用浏览器 Web Speech API");
    }

    @PostMapping(value = "/transcribe", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> transcribeMultipart(
            @RequestParam("audio") MultipartFile audio,
            @RequestParam(value = "format", defaultValue = "wav") String format,
            @RequestParam(value = "sampleRate", defaultValue = "16000") int sampleRate) {

        if (!aliyunAsrConfig.isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", "阿里云 ASR 未配置，请设置环境变量或使用浏览器语音识别"));
        }

        if (audio == null || audio.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "请上传 audio 文件"));
        }

        try {
            AliyunAsrService.TranscribeResult result = aliyunAsrService.transcribe(
                    audio.getBytes(), format, sampleRate);
            return ResponseEntity.ok(toResponse(result));
        } catch (java.io.IOException e) {
            return ResponseEntity.badRequest().body(Map.of("error", "读取音频文件失败"));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping(value = "/transcribe", consumes = MediaType.APPLICATION_FORM_URLENCODED_VALUE)
    public ResponseEntity<?> transcribeForm(
            @RequestParam("audioBase64") String audioBase64,
            @RequestParam(value = "format", defaultValue = "wav") String format,
            @RequestParam(value = "sampleRate", defaultValue = "16000") int sampleRate) {

        if (!aliyunAsrConfig.isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", "阿里云 ASR 未配置，请设置环境变量或使用浏览器语音识别"));
        }

        if (audioBase64 == null || audioBase64.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "audioBase64 不能为空"));
        }

        try {
            String payload = audioBase64.contains(",") ? audioBase64.substring(audioBase64.indexOf(',') + 1) : audioBase64;
            byte[] bytes = Base64.getDecoder().decode(payload);
            AliyunAsrService.TranscribeResult result = aliyunAsrService.transcribe(bytes, format, sampleRate);
            return ResponseEntity.ok(toResponse(result));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", e.getMessage()));
        }
    }

    private VoiceTranscribeResponse toResponse(AliyunAsrService.TranscribeResult result) {
        return new VoiceTranscribeResponse(
                result.text(),
                result.rawText(),
                "aliyun",
                result.homophoneFixed());
    }
}
