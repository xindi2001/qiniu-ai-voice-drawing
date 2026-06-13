package com.qiniu.voicedrawing.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@ConfigurationProperties(prefix = "aliyun")
public class AliyunAsrConfig {

    private static final Logger log = LoggerFactory.getLogger(AliyunAsrConfig.class);

    private String accessKeyId = "";
    private String accessKeySecret = "";
    private AsrProperties asr = new AsrProperties();

    @PostConstruct
    void logConfigurationStatus() {
        if (isConfigured()) {
            log.info("Aliyun ASR configured: yes (region={}, appKey set)", asr.getRegion());
        } else {
            log.info("Aliyun ASR configured: no — set ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET, ALIYUN_ASR_APP_KEY");
        }
    }

    public boolean isConfigured() {
        return accessKeyId != null && !accessKeyId.isBlank()
                && accessKeySecret != null && !accessKeySecret.isBlank()
                && asr.getAppKey() != null && !asr.getAppKey().isBlank();
    }

    public String getMetaDomain() {
        return "nls-meta." + asr.getRegion() + ".aliyuncs.com";
    }

    public String getGatewayAsrUrl() {
        return "https://nls-gateway-" + asr.getRegion() + ".aliyuncs.com/stream/v1/asr";
    }

    public String getAccessKeyId() {
        return accessKeyId;
    }

    public void setAccessKeyId(String accessKeyId) {
        this.accessKeyId = accessKeyId != null ? accessKeyId.trim() : "";
    }

    public String getAccessKeySecret() {
        return accessKeySecret;
    }

    public void setAccessKeySecret(String accessKeySecret) {
        this.accessKeySecret = accessKeySecret != null ? accessKeySecret.trim() : "";
    }

    public AsrProperties getAsr() {
        return asr;
    }

    public void setAsr(AsrProperties asr) {
        this.asr = asr;
    }

    public static class AsrProperties {
        private String appKey = "";
        private String region = "cn-shanghai";

        public String getAppKey() {
            return appKey;
        }

        public void setAppKey(String appKey) {
            this.appKey = appKey != null ? appKey.trim() : "";
        }

        public String getRegion() {
            return region;
        }

        public void setRegion(String region) {
            this.region = region;
        }
    }
}
