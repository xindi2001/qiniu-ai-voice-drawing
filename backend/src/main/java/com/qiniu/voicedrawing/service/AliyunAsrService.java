package com.qiniu.voicedrawing.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.qiniu.voicedrawing.config.AliyunAsrConfig;
import com.qiniu.voicedrawing.util.AsrHomophoneHelper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;

@Service
public class AliyunAsrService {

    private static final Logger log = LoggerFactory.getLogger(AliyunAsrService.class);

    private final AliyunAsrConfig config;
    private final AliyunTokenService tokenService;
    private final ObjectMapper objectMapper;
    private final RestTemplate restTemplate;

    public AliyunAsrService(AliyunAsrConfig config, AliyunTokenService tokenService, ObjectMapper objectMapper) {
        this.config = config;
        this.tokenService = tokenService;
        this.objectMapper = objectMapper;
        this.restTemplate = new RestTemplate();
    }

    public TranscribeResult transcribe(byte[] audioBytes, String format, int sampleRate) {
        if (!config.isConfigured()) {
            throw new IllegalStateException("Aliyun ASR is not configured");
        }
        if (audioBytes == null || audioBytes.length == 0) {
            throw new IllegalArgumentException("音频数据为空");
        }

        String normalizedFormat = normalizeFormat(format);
        String token = tokenService.getToken();

        URI uri = UriComponentsBuilder
                .fromHttpUrl(config.getGatewayAsrUrl())
                .queryParam("appkey", config.getAsr().getAppKey())
                .queryParam("format", normalizedFormat)
                .queryParam("sample_rate", sampleRate)
                .build()
                .toUri();

        HttpHeaders headers = new HttpHeaders();
        headers.set("X-NLS-Token", token);
        headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);

        HttpEntity<byte[]> entity = new HttpEntity<>(audioBytes, headers);

        try {
            ResponseEntity<String> response = restTemplate.postForEntity(uri, entity, String.class);
            JsonNode root = objectMapper.readTree(response.getBody());
            int status = root.path("status").asInt(-1);
            String message = root.path("message").asText("");
            String rawText = root.path("result").asText("");

            if (status != 20000000) {
                log.warn("Aliyun ASR failed: status={}, message={}", status, message);
                throw new IllegalStateException("阿里云 ASR 识别失败: " + message + " (status=" + status + ")");
            }

            String fixedText = AsrHomophoneHelper.fixHomophones(rawText);
            boolean homophoneFixed = !fixedText.equals(rawText);
            log.info("Aliyun ASR transcribed: \"{}\"{}", rawText, homophoneFixed ? " (homophone fixed)" : "");
            return new TranscribeResult(fixedText, rawText, homophoneFixed);
        } catch (RestClientResponseException e) {
            log.error("Aliyun ASR HTTP error: {}", e.getResponseBodyAsString());
            throw new IllegalStateException("阿里云 ASR 请求失败: HTTP " + e.getStatusCode().value());
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            log.error("Aliyun ASR call failed", e);
            throw new IllegalStateException("阿里云 ASR 调用异常: " + e.getMessage(), e);
        }
    }

    private String normalizeFormat(String format) {
        if (format == null || format.isBlank()) {
            return "wav";
        }
        return switch (format.toLowerCase()) {
            case "webm", "opus" -> "opus";
            case "pcm", "raw" -> "pcm";
            case "mp3" -> "mp3";
            default -> "wav";
        };
    }

    public record TranscribeResult(String text, String rawText, boolean homophoneFixed) {
    }
}
