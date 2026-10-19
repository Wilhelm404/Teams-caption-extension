# Teams Live Caption Capture — 开发记录

> 方便 AI 模型下次快速接手，无需重新理解项目。

## 项目概述

Chrome 扩展，抓取 Microsoft Teams Web 端会议中的实时字幕（Live Captions），保存为带发言人+时间戳的纯文本文件。

## 文件结构

| 文件 | 角色 |
|------|------|
| `manifest.json` | 扩展配置，MV3，content_scripts 注入 Teams 页面 |
| `capture.js` | **核心** — content script，DOM 抓取、状态管理、下载 |
| `popup.html` | 弹窗 UI：开始/停止/手动抓取/下载/清除 + 状态显示 |
| `popup.js` | 弹窗逻辑：与 content script 通信、UI 刷新 |

## 数据流

```
Teams DOM (.fui-ChatMessageCompact)
  → captureCurrentState()  每 N 秒扫描整个 DOM
  → capturedMessages (Map: uniqueId → {author, text, firstSeen, lastUpdated})
  → finalizeCompleteMessages()  每隔 5 秒检测「完整+稳定3秒」的句子
  → processedIds (Set)  标记已定稿
  → downloadTranscript()  拼接输出 .txt
```

## 关键设计决策

### 消息生命周期
1. **采集阶段**：同一 uniqueId 的消息会被原地更新（Teams 字幕逐步补全），而非追加新记录
2. **定稿条件**：文本以句末标点结束 **且** 3秒内未被更新
3. **去重**：下载时去除同一作者相邻重复内容

### uniqueId 策略（`getUniqueId()`）
优先级：`avatar-{id}` span 的 id → 作者名+稳定元素 id（WeakMap 绑定，抗滚动） → 作者名+容器序号

### 自动下载触发条件
- 字幕 DOM 从存在变为不存在（会议结束）
- 标签页关闭前（`beforeunload`）
- 标签页恢复可见后发现字幕消失

## 已完成的修改

### 2026-08-24: 新增「自动开启实时字幕」功能
- **修改位置**: `capture.js`（新增 auto-enable 逻辑 + 定时器 + 消息处理）、`popup.html`（新增开关 UI）、`popup.js`（开关事件 + storage 持久化）
- **功能**: 检测到用户已进入会议但字幕未开启时，自动点击「更多操作」菜单中的「开启实时字幕」，重试至字幕出现或达上限（10 次）
- **关键选择器**:
  - 进入会议判定: `[data-tid="call-controls"]` / `[data-tid="callingButtons-showMoreBtn"]`
  - 开启菜单项: 文本匹配 `Turn on live captions` / `开启实时字幕` / `開啟即時字幕` 等（含 `data-tid="live-captions-menu-item"` 兜底）
- **注意**: Teams 官方已在 2026-08 中旬推出原生「自动开启字幕」用户级设置（MC1447682），本功能是扩展侧的独立实现，两者不冲突；若租户已支持原生设置，可关闭扩展开关避免重复点击

### 2026-08-24: uniqueId 兜底改用 WeakMap 稳定元素 id
- **修改位置**: `capture.js` 状态声明（新增 `containerIdMap` / `containerIdCounter`）+ `getUniqueId()` 函数
- **改动**: 兜底策略由「作者名 + DOM 坐标（getBoundingClientRect）」改为「作者名 + WeakMap 绑定的稳定元素 id」
- **原因**: 原逻辑用字幕元素的屏幕坐标做身份标识，字幕滚动时坐标变化，同一条字幕会被误判为新记录，导致输出重复或串行。WeakMap 让每个 DOM 元素在生命周期内保持固定 id，滚动不再破坏身份映射。

### 2026-08-10: 修复中文标点支持
- **修改位置**: `capture.js#L32-34` — `isComplete()` 函数
- **改动**: 正则由 `/[.!?]$/` 改为 `/[.!?。！？]$/`
- **原因**: 原逻辑只认英文标点，中文字幕因末尾用 `。！？` 永不被判定为完整，导致下载时中文内容全部丢失

## 已知问题

### 1. 标签页最小化/后台时字幕丢失
- **原因**: Teams 在页面不可见时停止推送字幕到 DOM；Chrome 节流后台定时器
- **现有应对**: `visibilitychange` 监听器在页面恢复时自动下载已有内容
- **改进方向**: 无法从客户端彻底解决，取决于 Teams 自身行为

### 2. 中文标点与英文标点混用的边界情况
- 如 `好的。谢谢。` 会拆成两条记录；`好的，谢谢。` 整体作为一条

### 3. 标题提取的正则
- `getMeetingName()` 用 `document.title` 解析，不同语言/版本的 Teams 标题格式可能变化

### 4. 自动开启字幕依赖菜单文本匹配
- Teams 会更新「开启实时字幕」菜单项的文案/结构，若自动开启失效，需重新检查当前 `data-tid` 与文案（可打开 DevTools 检查「更多操作」菜单）
- 已提供 `Alt+E` 手动触发一次，便于现场调试

## 扩展使用方式

1. Chrome → `chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序 → 选择此文件夹
2. 打开 Teams Web 会议页面
3. 点击扩展图标，设置抓取间隔（默认10秒），点击 Start
4. 会议结束后自动下载，也可手动 `Alt+D`

## 技术栈约束

- Manifest V3（不能使用 background service worker 做长时间运行）
- 仅支持 `https://teams.microsoft.com/*` 和 `https://teams.cloud.microsoft/*`
- 所有数据存储在 `capturedMessages`（内存 Map），刷新页面即丢失
