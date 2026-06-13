package com.qiniu.voicedrawing.dto;

import java.util.List;

public class VoiceParseResponse {

    private String speak;
    private List<DrawAction> actions;
    private boolean mockMode;
    /** Non-null when DeepSeek failed and mock fallback was used. */
    private String warning;

    public VoiceParseResponse() {
    }

    public VoiceParseResponse(String speak, List<DrawAction> actions, boolean mockMode) {
        this.speak = speak;
        this.actions = actions;
        this.mockMode = mockMode;
    }

    public String getSpeak() {
        return speak;
    }

    public void setSpeak(String speak) {
        this.speak = speak;
    }

    public List<DrawAction> getActions() {
        return actions;
    }

    public void setActions(List<DrawAction> actions) {
        this.actions = actions;
    }

    public boolean isMockMode() {
        return mockMode;
    }

    public void setMockMode(boolean mockMode) {
        this.mockMode = mockMode;
    }

    public String getWarning() {
        return warning;
    }

    public void setWarning(String warning) {
        this.warning = warning;
    }
}
