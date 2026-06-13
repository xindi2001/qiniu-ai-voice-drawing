package com.qiniu.voicedrawing.dto;

public class VoiceTranscribeResponse {

    private String text;
    private String rawText;
    private String provider;
    private boolean homophoneFixed;

    public VoiceTranscribeResponse() {
    }

    public VoiceTranscribeResponse(String text, String rawText, String provider, boolean homophoneFixed) {
        this.text = text;
        this.rawText = rawText;
        this.provider = provider;
        this.homophoneFixed = homophoneFixed;
    }

    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }

    public String getRawText() {
        return rawText;
    }

    public void setRawText(String rawText) {
        this.rawText = rawText;
    }

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public boolean isHomophoneFixed() {
        return homophoneFixed;
    }

    public void setHomophoneFixed(boolean homophoneFixed) {
        this.homophoneFixed = homophoneFixed;
    }
}
