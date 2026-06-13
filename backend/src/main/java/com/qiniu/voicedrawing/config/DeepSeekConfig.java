package com.qiniu.voicedrawing.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@ConfigurationProperties(prefix = "deepseek")
public class DeepSeekConfig {

    private static final Logger log = LoggerFactory.getLogger(DeepSeekConfig.class);

    private String apiKey = "";
    private String apiUrl = "https://api.deepseek.com/chat/completions";
    private String model = "deepseek-chat";

    @PostConstruct
    void logConfigurationStatus() {
        if (isConfigured()) {
            log.info("DeepSeek configured: yes (API key loaded from environment)");
        } else {
            log.info("DeepSeek configured: no — mock mode will be used (set DEEPSEEK_API_KEY to enable)");
        }
    }

    public String getApiKey() {
        return apiKey;
    }

    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    public String getApiUrl() {
        return apiUrl;
    }

    public void setApiUrl(String apiUrl) {
        this.apiUrl = apiUrl;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public boolean isConfigured() {
        return apiKey != null && !apiKey.isBlank();
    }
}
