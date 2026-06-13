package com.qiniu.voicedrawing.dto;

public class AsrStatusResponse {

    private boolean aliyunConfigured;
    private String recommendedProvider;
    private String message;

    public AsrStatusResponse() {
    }

    public AsrStatusResponse(boolean aliyunConfigured, String recommendedProvider, String message) {
        this.aliyunConfigured = aliyunConfigured;
        this.recommendedProvider = recommendedProvider;
        this.message = message;
    }

    public boolean isAliyunConfigured() {
        return aliyunConfigured;
    }

    public void setAliyunConfigured(boolean aliyunConfigured) {
        this.aliyunConfigured = aliyunConfigured;
    }

    public String getRecommendedProvider() {
        return recommendedProvider;
    }

    public void setRecommendedProvider(String recommendedProvider) {
        this.recommendedProvider = recommendedProvider;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }
}
