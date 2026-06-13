package com.qiniu.voicedrawing.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

public class VoiceParseRequest {

    @NotBlank(message = "text 不能为空")
    @Size(max = 500, message = "text 长度不能超过 500 字符")
    private String text;

    private List<SceneShapeContext> sceneContext;

    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }

    public List<SceneShapeContext> getSceneContext() {
        return sceneContext;
    }

    public void setSceneContext(List<SceneShapeContext> sceneContext) {
        this.sceneContext = sceneContext;
    }
}
