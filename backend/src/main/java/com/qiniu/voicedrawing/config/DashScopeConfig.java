package com.qiniu.voicedrawing.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@ConfigurationProperties(prefix = "dashscope")
public class DashScopeConfig {

    private static final Logger log = LoggerFactory.getLogger(DashScopeConfig.class);

    private String apiKey = "";
    private String baseUrl = "https://dashscope.aliyuncs.com";
    private String model = "wanx2.1-t2i-turbo";
    private String imageSize = "768*768";
    /** Optional style hint (wanx-v1 only); leave blank for wanx2.x models. */
    private String style = "";

    @PostConstruct
    void logConfigurationStatus() {
        if (isConfigured()) {
            log.info("DashScope (Wanx) configured: yes (API key loaded from environment)");
        } else {
            log.info("DashScope (Wanx) configured: no — picture mode unavailable "
                    + "(set DASHSCOPE_API_KEY to enable 通义万相生图)");
        }
    }

    public String getApiKey() {
        return apiKey;
    }

    public void setApiKey(String apiKey) {
        this.apiKey = apiKey != null ? apiKey.trim() : "";
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public String getImageSize() {
        return imageSize;
    }

    public void setImageSize(String imageSize) {
        this.imageSize = imageSize;
    }

    public String getStyle() {
        return style;
    }

    public void setStyle(String style) {
        this.style = style != null ? style.trim() : "";
    }

    public boolean isConfigured() {
        return apiKey != null && !apiKey.isBlank();
    }

    public String imageSynthesisUrl() {
        return baseUrl + "/api/v1/services/aigc/text2image/image-synthesis";
    }

    public String taskUrl(String taskId) {
        return baseUrl + "/api/v1/tasks/" + taskId;
    }
}
