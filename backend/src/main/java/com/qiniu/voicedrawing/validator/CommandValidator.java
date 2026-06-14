package com.qiniu.voicedrawing.validator;

import com.qiniu.voicedrawing.dto.DrawAction;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

@Component
public class CommandValidator {

    private static final Pattern ICON_ID_PATTERN = Pattern.compile("^[a-z0-9-]+:[a-z0-9-]+$", Pattern.CASE_INSENSITIVE);

    private static final Set<String> ALLOWED_ACTIONS = Set.of(
            "draw", "draw_stroke", "draw_paths", "drawpath", "generate_and_trace",
            "usetemplate", "useicon",
            "modify", "delete", "undo", "redo", "clear"
    );

    private static final Set<String> ALLOWED_SHAPES = Set.of(
            "circle", "rect", "line"
    );

    private static final Set<String> ALLOWED_TEMPLATES = Set.of(
            "house", "horse", "tree", "sun", "star", "triangle"
    );

    public List<String> validateActions(List<DrawAction> actions) {
        List<String> errors = new ArrayList<>();
        if (actions == null || actions.isEmpty()) {
            errors.add("actions 不能为空");
            return errors;
        }

        for (int i = 0; i < actions.size(); i++) {
            DrawAction action = actions.get(i);
            String prefix = "actions[" + i + "]";

            if (action.getAction() == null || action.getAction().isBlank()) {
                errors.add(prefix + ".action 不能为空");
                continue;
            }

            String actionType = action.getAction().toLowerCase();
            if (!ALLOWED_ACTIONS.contains(actionType)) {
                errors.add(prefix + ".action 不支持: " + action.getAction());
            }

            switch (actionType) {
                case "draw", "draw_stroke" -> validateDrawAction(action, prefix, errors);
                case "draw_paths" -> validateDrawPathsAction(action, prefix, errors);
                case "drawpath" -> validateDrawPathAction(action, prefix, errors);
                case "generate_and_trace" -> validateGenerateAndTraceAction(action, prefix, errors);
                case "usetemplate" -> validateUseTemplateAction(action, prefix, errors);
                case "useicon" -> validateUseIconAction(action, prefix, errors);
                default -> { /* undo/redo/clear/modify/delete — no extra fields required */ }
            }
        }

        return errors;
    }

    private void validateDrawAction(DrawAction action, String prefix, List<String> errors) {
        boolean hasPoints = action.getPoints() != null && action.getPoints().size() >= 2;
        boolean hasPaths = action.getPaths() != null && !action.getPaths().isEmpty();
        if (hasPoints || hasPaths) {
            return;
        }
        if (action.getShape() == null || action.getShape().isBlank()) {
            errors.add(prefix + ".shape 不能为空（或提供 points/paths）");
            return;
        }

        String shape = action.getShape().toLowerCase();
        if (!ALLOWED_SHAPES.contains(shape)) {
            errors.add(prefix + ".shape 不支持: " + action.getShape());
        }
    }

    private void validateGenerateAndTraceAction(DrawAction action, String prefix, List<String> errors) {
        if (action.getImagePrompt() == null || action.getImagePrompt().isBlank()) {
            errors.add(prefix + ".imagePrompt 不能为空");
        }
    }

    private void validateDrawPathAction(DrawAction action, String prefix, List<String> errors) {
        if (action.getPoints() == null || action.getPoints().size() < 2) {
            errors.add(prefix + ".points 至少需要 2 个坐标点");
        }
    }

    private void validateDrawPathsAction(DrawAction action, String prefix, List<String> errors) {
        if (action.getPathItems() == null || action.getPathItems().isEmpty()) {
            errors.add(prefix + ".pathItems 不能为空");
            return;
        }
        if (action.getPathItems().size() > 30) {
            errors.add(prefix + ".pathItems 最多 30 条路径");
        }
        for (int j = 0; j < action.getPathItems().size(); j++) {
            var item = action.getPathItems().get(j);
            if (item.getPoints() == null || item.getPoints().size() < 2) {
                errors.add(prefix + ".pathItems[" + j + "].points 至少需要 2 个坐标点");
            }
        }
    }

    private void validateUseTemplateAction(DrawAction action, String prefix, List<String> errors) {
        if (action.getTemplateId() == null || action.getTemplateId().isBlank()) {
            errors.add(prefix + ".templateId 不能为空");
            return;
        }
        if (!ALLOWED_TEMPLATES.contains(action.getTemplateId().toLowerCase())) {
            errors.add(prefix + ".templateId 不支持: " + action.getTemplateId());
        }
    }

    private void validateUseIconAction(DrawAction action, String prefix, List<String> errors) {
        if (action.getIconId() == null || action.getIconId().isBlank()) {
            errors.add(prefix + ".iconId 不能为空");
            return;
        }
        if (!ICON_ID_PATTERN.matcher(action.getIconId()).matches()) {
            errors.add(prefix + ".iconId 格式无效（应为 prefix:name，如 mdi:horse）: " + action.getIconId());
        }
    }
}
