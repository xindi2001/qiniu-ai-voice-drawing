package com.qiniu.voicedrawing.controller;

import com.qiniu.voicedrawing.dto.VoiceParseRequest;
import com.qiniu.voicedrawing.dto.VoiceParseResponse;
import com.qiniu.voicedrawing.service.VoiceCommandService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/v1/voice")
public class VoiceCommandController {

    private final VoiceCommandService voiceCommandService;

    public VoiceCommandController(VoiceCommandService voiceCommandService) {
        this.voiceCommandService = voiceCommandService;
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    @PostMapping("/parse")
    public VoiceParseResponse parse(@Valid @RequestBody VoiceParseRequest request) {
        return voiceCommandService.parse(request);
    }
}
