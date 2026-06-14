package com.qiniu.voicedrawing.controller;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestTemplate;

@RestController
@RequestMapping("/api/v1/icons")
public class IconProxyController {

    private static final String ICONIFY_BASE = "https://api.iconify.design";

    private final RestTemplate restTemplate = new RestTemplate();

    @GetMapping(value = "/{iconId}", produces = "image/svg+xml")
    public ResponseEntity<String> fetchIcon(@PathVariable String iconId) {
        if (!iconId.matches("(?i)[a-z0-9-]+:[a-z0-9-]+")) {
            return ResponseEntity.badRequest().body("invalid iconId format");
        }

        String url = ICONIFY_BASE + "/" + iconId.replace(':', '/') + ".svg";
        try {
            ResponseEntity<String> response = restTemplate.getForEntity(url, String.class);
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body("icon not found");
            }
            return ResponseEntity.ok()
                    .contentType(MediaType.parseMediaType("image/svg+xml"))
                    .body(response.getBody());
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body("icon fetch failed");
        }
    }
}
