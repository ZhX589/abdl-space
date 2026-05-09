# ABDL Space 样式指南

> 本文件定义了项目的视觉规范。**所有颜色必须通过 CSS 变量引用，不得硬编码色值。**

## CSS 变量速查表

以下变量已在 `src/index.css` 中定义，直接在代码中使用 `var(--variable-name)`：

### 亮色模式（:root）

| CSS 变量 | 色值 | 用途 |
| :--- | :--- | :--- |
| `--color-primary` | `#5BA3E6` | 主色：导航栏、按钮、链接 |
| `--color-primary-light` | `#B3D9FF` | 主色浅：背景块、卡片头 |
| `--color-primary-lighter` | `#E8F4FD` | 主色淡：页面背景 |
| `--color-secondary` | `#87CEEB` | 辅助色 |
| `--color-accent` | `#FF8C94` | 强调色：评分星标、通知 |
| `--color-star` | `#FFD700` | 星标高亮色 |
| `--text-primary` | `#2C3E50` | 主文字 |
| `--text-secondary` | `#7F8C8D` | 辅助文字 |
| `--text-on-primary` | `#FFFFFF` | 主色背景上的文字 |
| `--bg-page` | `#E8F4FD` | 页面背景 |
| `--bg-card` | `rgba(255,255,255,0.7)` | 卡片背景 |
| `--glass-bg` | `rgba(255,255,255,0.15)` | 毛玻璃基础色 |
| `--glass-border` | `1px solid rgba(255,255,255,0.2)` | 毛玻璃边框 |
| `--glass-blur` | `12px` | 毛玻璃模糊度 |
| `--radius-sm` | `8px` | 小圆角（按钮） |
| `--radius-lg` | `16px` | 大圆角（卡片） |

### 暗色模式（[data-theme="dark"]）

自动切换，无需手动指定。关键变化：

| CSS 变量 | 暗色值 | 变化方向 |
| :--- | :--- | :--- |
| `--color-primary` | `#87CEEB` | 调亮 |
| `--bg-page` | `#0f0f23` | 深空蓝底 |
| `--text-primary` | `#E8E8F0` | 变亮 |
| `--glass-bg` | `rgba(255,255,255,0.08)` | 更透 |
| `--glass-border` | `1px solid rgba(255,255,255,0.1)` | 更淡 |

## ✅ 正确 vs ❌ 错误

### 颜色

```css
/* ✅ 正确：使用 CSS 变量 */
.button { background: var(--color-primary); }

/* ❌ 错误：硬编码色值 */
.button { background: #5BA3E6; }
```

### 毛玻璃

```tsx
// ✅ 正确：使用 .glass 类
<div className="glass">内容</div>

// ❌ 错误：重新写一遍 backdrop-filter
<div style={{ backdropFilter: 'blur(12px)', background: 'rgba(...)' }}>内容</div>
```

### 主题切换

```css
/* ✅ 正确：使用 data-theme 属性控制 */
[data-theme="dark"] .card { background: var(--bg-card); }

/* ❌ 错误：媒体查询无法覆盖手动切换 */
@media (prefers-color-scheme: dark) { ... }
```

## 毛玻璃规范

```css
.glass {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: var(--glass-border);
  border-radius: var(--radius-lg);
}

/* 移动端自动优化 blur，无需手动处理 */
```

## 圆角体系

| 变量名 | 值 | 适用 |
| :--- | :--- | :--- |
| `--radius-sm` | `8px` | 按钮、输入框、标签、评分维度标签 |
| `--radius-lg` | `16px` | 卡片、弹窗、容器、纸尿裤卡片 |

## 响应式断点

| 断点 | 说明 |
| :--- | :--- |
| `768px` | 移动端 → 平板（此断点下 glass blur 自动减半） |
| `1024px` | 平板 → 桌面 |

## 暗亮色切换机制

1. **HTML 属性驱动**：`<html data-theme="dark">` 或 `data-theme="light"`
2. **自动跟随**：首次访问根据 `prefers-color-scheme` 设置
3. **手动切换**：用户点击切换按钮，存入 `localStorage`
4. **优先级**：`localStorage` > `prefers-color-scheme`

> 所有颜色值定义在 `src/index.css` 的 `:root` 和 `[data-theme="dark"]` 中，新增组件时引用 CSS 变量即可自动适配双主题。

## 组件样式规范

### 纸尿裤卡片

- 外层使用 `glass` 类
- 品牌名用 `--color-primary`，型号用 `--text-primary`
- 综合评分用 `--color-star` 高亮
- 厚度指示器用 `--color-accent` 填充
- 尺码标签用 `--color-primary-light` 背景 + `--color-primary` 文字

### 评分雷达图

- 6 个维度的雷达图
- 填充色：`--color-primary-light`（半透明）
- 边线色：`--color-primary`
- 维度标签：`--text-secondary`
- 当前用户评分叠加显示，用 `--color-accent` 区分

### 排行榜

- 前三名使用 `--color-star` 徽章
- 列表项使用 `glass` 类，hover 时加深 `--glass-bg`
- 切换按钮组用 `--color-primary` 标识当前选中

### 论坛帖子

- 帖子卡片使用 `glass` 类
- 置顶标记用 `--color-accent` 背景
- 关联纸尿裤标签用 `--color-primary-light` 背景
- 评论嵌套用左侧 `--color-primary-light` 竖线标识层级

### Wiki 段评

- 段落 hover 时右侧显示评论图标（`--color-primary`）
- 已评论段落左侧显示 `--color-primary` 竖线指示
- 评论文本框出现在段落右侧，使用 `glass` 类
