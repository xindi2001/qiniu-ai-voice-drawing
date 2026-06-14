package com.qiniu.voicedrawing.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class ImageGenerateResponse {

    private String imageUrl;
    private String imageBase64;
    private String mimeType;
    private boolean configured;

    public ImageGenerateResponse() {
    }

    public ImageGenerateResponse(String imageUrl, String imageBase64, String mimeType) {
        this.imageUrl = imageUrl;
        this.imageBase64 = imageBase64;
        this.mimeType = mimeType;
        this.configured = true;
    }

    public static ImageGenerateResponse notConfigured() {
        ImageGenerateResponse response = new ImageGenerateResponse();
        response.setConfigured(false);
        return response;
    }

    public String getImageUrl() {
        return imageUrl;
    }

    public void setImageUrl(String imageUrl) {
        this.imageUrl = imageUrl;
    }

    public String getImageBase64() {
        return imageBase64;
    }

    public void setImageBase64(String imageBase64) {
        this.imageBase64 = imageBase64;
    }

    public String getMimeType() {
        return mimeType;
    }

    public void setMimeType(String mimeType) {
        this.mimeType = mimeType;
    }

    public boolean isConfigured() {
        return configured;
    }

    public void setConfigured(boolean configured) {
        this.configured = configured;
    }
}
