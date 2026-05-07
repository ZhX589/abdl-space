# ABDL Space Wiki 样式指南

## 品牌色

### 亮色模式

| 用途 | 色值 | 说明 |
| :--- | :--- | :--- |
| 主色 | `#5BA3E6` | 天蓝，用于导航栏、按钮、链接 |
| 主色浅 | `#B3D9FF` | 浅蓝，用于背景块、卡片 |
| 主色淡 | `#E8F4FD` | 极浅蓝，用于页面背景 |
| 次要色 | `#87CEEB` | 天蓝，用于辅助元素 |
| 强调色 | `#FF8C94` | 暖粉，用于评分星标、通知徽标 |
| 强调色2 | `#FFD700` | 金色，用于星级高亮 |
| 文字主 | `#2C3E50` | 深蓝灰 |
| 文字次 | `#7F8C8D` | 灰色 |
| 卡片底 | `rgba(255, 255, 255, 0.7)` | 毛玻璃卡片背景 |

### 暗色模式

| 用途 | 色值 | 说明 |
| :--- | :--- | :--- |
| 背景 | `#0f0f23` | 深空蓝 |
| 卡片底 | `rgba(255, 255, 255, 0.08)` | 半透明白 |
| 导航底 | `rgba(15, 15, 35, 0.85)` | 深色导航毛玻璃 |
| 文字主 | `#E8E8F0` | 浅灰白 |
| 文字次 | `#A0A0B0` | 中灰色 |

## 毛玻璃规范

```css
/* 标准毛玻璃卡片 */
.glass {
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px;
}

/* 暗色模式毛玻璃 */
[data-theme="dark"] .glass {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

/* 移动端优化（降低 blur 减少性能开销） */
@media (max-width: 768px) {
  .glass {
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
}
```

## 圆角体系

| 层级 | 值 | 适用 |
| :--- | :--- | :--- |
| 小 | `8px` | 按钮、输入框、小标签 |
| 中 | `12px` | 卡片、弹窗 |
| 大 | `16px` | 主卡片、容器 |
| 圆 | `50%` | 头像、图标 |

## 阴影

```css
/* 亮色 */
box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);

/* 暗色 */
box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);

/* 悬浮提升 */
box-shadow: 0 8px 30px rgba(0, 0, 0, 0.1);
```

## 字体

- 中文：系统默认（`-apple-system`, `PingFang SC`, `Microsoft YaHei`）
- 英文/数字：`Inter` 或系统无衬线
- 字号：`14px`（小）/ `16px`（默认）/ `20px`（标题）/ `28px`（大标题）

## 响应式断点

| 断点 | 宽度 | 布局调整 |
| :--- | :--- | :--- |
| xs | `< 640px` | 单列，底部导航，缩小毛玻璃 blur |
| sm | `640px+` | 双列布局开始 |
| md | `768px+` | 标准布局 |
| lg | `1024px+` | 侧边栏固定 |
| xl | `1280px+` | 最大宽度限制，居中 |

## 暗亮色切换机制

1. 使用 CSS 变量 + `data-theme` 属性
2. 默认跟随系统 `prefers-color-scheme`
3. 手动切换后存储到 `localStorage`
4. 所有颜色值通过 CSS 变量引用，不硬编码

```css
:root {
  --bg-primary: #E8F4FD;
  --bg-card: rgba(255, 255, 255, 0.7);
  --text-primary: #2C3E50;
  /* ... */
}

[data-theme="dark"] {
  --bg-primary: #0f0f23;
  --bg-card: rgba(255, 255, 255, 0.08);
  --text-primary: #E8E8F0;
  /* ... */
}
```

## 组件风格要点

- **导航栏**：顶部固定，毛玻璃效果，包含 logo、搜索、主题切换、用户菜单
- **卡片**：毛玻璃、大圆角、柔和阴影，适当内边距（`24px`）
- **按钮**：圆角 `8px`，主色填充或 outline，悬浮有轻微上移效果
- **评分星标**：五角星，强调色高亮，可点击或只读
- **评论区**：卡片式排列，嵌套回复缩进，头像圆形
- **Wiki 内容区**：最大宽度 `800px`，居中，Markdown 渲染
