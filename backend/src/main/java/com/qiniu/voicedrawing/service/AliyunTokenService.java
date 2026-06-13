package com.qiniu.voicedrawing.service;

import com.aliyuncs.CommonRequest;
import com.aliyuncs.CommonResponse;
import com.aliyuncs.DefaultAcsClient;
import com.aliyuncs.IAcsClient;
import com.aliyuncs.http.MethodType;
import com.aliyuncs.http.ProtocolType;
import com.aliyuncs.profile.DefaultProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.qiniu.voicedrawing.config.AliyunAsrConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;

/**
 * Fetches and caches Aliyun NLS access tokens via CreateToken OpenAPI.
 */
@Service
public class AliyunTokenService {

    private static final Logger log = LoggerFactory.getLogger(AliyunTokenService.class);
    private static final long REFRESH_BUFFER_SECONDS = 300;

    private final AliyunAsrConfig config;
    private final ObjectMapper objectMapper;
    private volatile String cachedToken;
    private volatile long tokenExpireEpochSeconds;

    public AliyunTokenService(AliyunAsrConfig config, ObjectMapper objectMapper) {
        this.config = config;
        this.objectMapper = objectMapper;
    }

    public synchronized String getToken() {
        if (!config.isConfigured()) {
            throw new IllegalStateException("Aliyun ASR is not configured");
        }

        long now = Instant.now().getEpochSecond();
        if (cachedToken != null && now < tokenExpireEpochSeconds - REFRESH_BUFFER_SECONDS) {
            return cachedToken;
        }

        try {
            DefaultProfile profile = DefaultProfile.getProfile(
                    config.getAsr().getRegion(),
                    config.getAccessKeyId(),
                    config.getAccessKeySecret());
            IAcsClient client = new DefaultAcsClient(profile);

            String region = config.getAsr().getRegion();

            CommonRequest request = new CommonRequest();
            request.setSysMethod(MethodType.POST);
            request.setSysProtocol(ProtocolType.HTTPS);
            request.setSysDomain(config.getMetaDomain());
            request.setSysVersion("2019-02-28");
            request.setSysAction("CreateToken");
            request.setSysRegionId(region);
            request.putQueryParameter("RegionId", region);

            CommonResponse response = client.getCommonResponse(request);
            if (response.getHttpStatus() != 200) {
                throw new IllegalStateException("CreateToken HTTP " + response.getHttpStatus());
            }

            JsonNode root = objectMapper.readTree(response.getData());
            JsonNode tokenNode = root.path("Token");
            cachedToken = tokenNode.path("Id").asText(null);
            tokenExpireEpochSeconds = tokenNode.path("ExpireTime").asLong(0);

            if (cachedToken == null || cachedToken.isBlank()) {
                throw new IllegalStateException("CreateToken returned empty token");
            }

            log.info("Aliyun NLS token refreshed, expires at epoch {}", tokenExpireEpochSeconds);
            return cachedToken;
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : e.toString();
            if (msg.contains("SignatureDoesNotMatch")) {
                log.error("Failed to obtain Aliyun NLS token (AccessKeyId suffix={})",
                        maskAccessKeyIdSuffix(config.getAccessKeyId()), e);
                throw new IllegalStateException(
                        "无法获取阿里云 NLS Token（SignatureDoesNotMatch）：请确认 AccessKey ID 与 AccessKey Secret "
                                + "来自 RAM 控制台同一对密钥，环境变量中无首尾空格；若密钥曾在截图或聊天中泄露，请先在控制台轮换后再更新配置。详情: "
                                + msg,
                        e);
            }
            log.error("Failed to obtain Aliyun NLS token", e);
            throw new IllegalStateException("无法获取阿里云 NLS Token: " + msg, e);
        }
    }

    private static String maskAccessKeyIdSuffix(String accessKeyId) {
        if (accessKeyId == null || accessKeyId.length() <= 4) {
            return "****";
        }
        return "****" + accessKeyId.substring(accessKeyId.length() - 4);
    }
}
