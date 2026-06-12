package com.qiniu.voicedrawing.validator;

import com.qiniu.voicedrawing.dto.DrawAction;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

@Component
public class CommandValidator {

    private static final Set<String> ALLOWED_ACTIONS = Set.of(
            "draw", "modify", "delete", "undo", "redo", "clear"
    );

    private static final Set<String> ALLOWED_SHAPES = Set.of(
            "circle", "rect", "line"
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

            if ("draw".equals(actionType)) {
                validateDrawAction(action, prefix, errors);
            }
        }

        return errors;
    }

    private void validateDrawAction(DrawAction action, String prefix, List<String> errors) {
        if (action.getShape() == null || action.getShape().isBlank()) {
            errors.add(prefix + ".shape 不能为空");
            return;
        }

        String shape = action.getShape().toLowerCase();
        if (!ALLOWED_SHAPES.contains(shape)) {
            errors.add(prefix + ".shape 不支持: " + action.getShape());
        }
    }
}
