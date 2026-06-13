package com.qiniu.voicedrawing.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public class VoiceParseRequest {

    @NotBlank(message = "text 不能为空")
    @Size(max = 500, message = "text 长度不能超过 500 字符")
    private String text;

    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }
}
