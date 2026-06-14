package com.qiniu.voicedrawing.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

public class VoiceParseRequest {

    @NotBlank(message = "text 不能为空")
    @Size(max = 500, message = "text 长度不能超过 500 字符")
    private String text;

    private List<SceneShapeContext> sceneContext;

    /** 前端「精细描摹模式」：提升万相生图质量与描摹细节，适合头像/精细人像 */
    private Boolean fineDetailMode;

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

    public Boolean getFineDetailMode() {
        return fineDetailMode;
    }

    public void setFineDetailMode(Boolean fineDetailMode) {
        this.fineDetailMode = fineDetailMode;
    }
}
