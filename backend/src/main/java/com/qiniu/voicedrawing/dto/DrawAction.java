package com.qiniu.voicedrawing.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class DrawAction {

    private String action;
    private String shape;
    private String color;
    private Integer x;
    private Integer y;
    private Integer width;
    private Integer height;
    private Integer radius;
    private Integer x1;
    private Integer y1;
    private Integer x2;
    private Integer y2;
    private String targetId;
    private List<List<Integer>> points;
    private String templateId;
    private String iconId;
    private Double scale;
    private Integer animateMs;
    private Boolean closed;
    /** geometry | picture — 几何笔画 vs 生图描摹 */
    private String mode;
    /** 通义万相生图 prompt（简笔画、白底黑线） */
    private String imagePrompt;
    /** SVG path d 字符串或折线点序列的矢量化路径 */
    private List<String> paths;
    /** draw_paths：多条折线笔画，每项含 points 与 color */
    private List<PathItem> pathItems;
    /** true = 空心/描边圆环，不填充；null/false = 实心（默认） */
    private Boolean strokeOnly;
    private Map<String, Object> params;

    public String getAction() {
        return action;
    }

    public void setAction(String action) {
        this.action = action;
    }

    public String getShape() {
        return shape;
    }

    public void setShape(String shape) {
        this.shape = shape;
    }

    public String getColor() {
        return color;
    }

    public void setColor(String color) {
        this.color = color;
    }

    public Integer getX() {
        return x;
    }

    public void setX(Integer x) {
        this.x = x;
    }

    public Integer getY() {
        return y;
    }

    public void setY(Integer y) {
        this.y = y;
    }

    public Integer getWidth() {
        return width;
    }

    public void setWidth(Integer width) {
        this.width = width;
    }

    public Integer getHeight() {
        return height;
    }

    public void setHeight(Integer height) {
        this.height = height;
    }

    public Integer getRadius() {
        return radius;
    }

    public void setRadius(Integer radius) {
        this.radius = radius;
    }

    public Integer getX1() {
        return x1;
    }

    public void setX1(Integer x1) {
        this.x1 = x1;
    }

    public Integer getY1() {
        return y1;
    }

    public void setY1(Integer y1) {
        this.y1 = y1;
    }

    public Integer getX2() {
        return x2;
    }

    public void setX2(Integer x2) {
        this.x2 = x2;
    }

    public Integer getY2() {
        return y2;
    }

    public void setY2(Integer y2) {
        this.y2 = y2;
    }

    public String getTargetId() {
        return targetId;
    }

    public void setTargetId(String targetId) {
        this.targetId = targetId;
    }

    public List<List<Integer>> getPoints() {
        return points;
    }

    public void setPoints(List<List<Integer>> points) {
        this.points = points;
    }

    public String getTemplateId() {
        return templateId;
    }

    public void setTemplateId(String templateId) {
        this.templateId = templateId;
    }

    public String getIconId() {
        return iconId;
    }

    public void setIconId(String iconId) {
        this.iconId = iconId;
    }

    public Double getScale() {
        return scale;
    }

    public void setScale(Double scale) {
        this.scale = scale;
    }

    public Integer getAnimateMs() {
        return animateMs;
    }

    public void setAnimateMs(Integer animateMs) {
        this.animateMs = animateMs;
    }

    public Boolean getClosed() {
        return closed;
    }

    public void setClosed(Boolean closed) {
        this.closed = closed;
    }

    public String getMode() {
        return mode;
    }

    public void setMode(String mode) {
        this.mode = mode;
    }

    public String getImagePrompt() {
        return imagePrompt;
    }

    public void setImagePrompt(String imagePrompt) {
        this.imagePrompt = imagePrompt;
    }

    public List<String> getPaths() {
        return paths;
    }

    public void setPaths(List<String> paths) {
        this.paths = paths;
    }

    public List<PathItem> getPathItems() {
        return pathItems;
    }

    public void setPathItems(List<PathItem> pathItems) {
        this.pathItems = pathItems;
    }

    public Boolean getStrokeOnly() {
        return strokeOnly;
    }

    public void setStrokeOnly(Boolean strokeOnly) {
        this.strokeOnly = strokeOnly;
    }

    public Map<String, Object> getParams() {
        return params;
    }

    public void setParams(Map<String, Object> params) {
        this.params = params;
    }
}
