package com.qiniu.voicedrawing.dto;

import jakarta.validation.constraints.NotBlank;

public class ImageGenerateRequest {

    @NotBlank(message = "prompt 不能为空")
    private String prompt;
    private Boolean fineDetail;
    private String drawMode;

    public String getPrompt() {
        return prompt;
    }

    public void setPrompt(String prompt) {
        this.prompt = prompt;
    }

    public Boolean getFineDetail() {
        return fineDetail;
    }

    public void setFineDetail(Boolean fineDetail) {
        this.fineDetail = fineDetail;
    }

    public String getDrawMode() {
        return drawMode;
    }

    public void setDrawMode(String drawMode) {
        this.drawMode = drawMode;
    }
}
