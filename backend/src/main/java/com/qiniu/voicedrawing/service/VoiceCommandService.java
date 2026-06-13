package com.qiniu.voicedrawing.service;

import com.qiniu.voicedrawing.dto.VoiceParseRequest;
import com.qiniu.voicedrawing.dto.VoiceParseResponse;
import com.qiniu.voicedrawing.validator.CommandValidator;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class VoiceCommandService {

    private final DeepSeekService deepSeekService;
    private final CommandValidator commandValidator;

    public VoiceCommandService(DeepSeekService deepSeekService, CommandValidator commandValidator) {
        this.deepSeekService = deepSeekService;
        this.commandValidator = commandValidator;
    }

    public VoiceParseResponse parse(VoiceParseRequest request) {
        VoiceParseResponse response = deepSeekService.parseCommand(
                request.getText(), request.getSceneContext());

        List<String> errors = commandValidator.validateActions(response.getActions());
        if (!errors.isEmpty()) {
            throw new IllegalArgumentException("命令校验失败: " + String.join("; ", errors));
        }

        return response;
    }
}
