package com.qiniu.voicedrawing.util;

/**
 * Fixes common ASR homophone errors for drawing commands.
 */
public final class AsrHomophoneHelper {

    private AsrHomophoneHelper() {
    }

    public static String fixHomophones(String text) {
        if (text == null || text.isBlank()) {
            return text;
        }

        String result = text.replace('园', '圆');

        if (result.contains("元") && isDrawingContext(result)) {
            result = result.replace('元', '圆');
        }

        return result;
    }

    private static boolean isDrawingContext(String text) {
        return text.contains("画")
                || text.contains("圆")
                || text.contains("形")
                || text.contains("个")
                || text.contains("的");
    }
}
