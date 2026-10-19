# Teams Live Caption Capture — 功能说明文档

> 版本 2.0 · Manifest V3 · 本地运行，数据不出浏览器

## 1. 项目概述

**Teams Live Caption Capture** 是一个 Chrome 浏览器扩展，用于抓取 Microsoft Teams **网页版**会议中的实时字幕（Live Captions），并自动保存为带「发言人 + 时间戳」的纯文本文件。

它解决的核心问题是：Teams Web 端本身不提供便捷的字幕导出能力，用户在会议中无法留存完整的文字记录。本扩展在会议进行时持续扫描页面 DOM，将字幕逐条采集、定稿并最终下载为 `.txt` 文件，供后续归档、检索或喂给下游总结工具（如会议纪要自动生成流程）使用。

## 2. 功能清单

| 功能 | 说明 |
|------|------|
| 实时字幕采集 | 按可配置间隔扫描 Teams 字幕 DOM，提取发言人 + 字幕文本 |
| 自动开启字幕 | 进入会议后自动点击「更多操作 → 开启实时字幕」，免手动开启 |
| 字幕增量更新 | 同一句话在 Teams 逐步补全时原地更新，而非追加重复记录 |
| 自动定稿 | 识别「完整且稳定」的句子（句末标点 + 稳定 3 秒）后才纳入输出 |
| 自动下载 | 会议结束 / 关闭标签页 / 恢复页面发现字幕消失时自动触发 |
| 手动操作 | 弹窗按钮 + 快捷键（Alt+D 下载、Alt+C 清空、Alt+S 强抓、Alt+E 手动触发开启字幕） |
| 去重 | 下载时去除同一发言人相邻的重复内容 |
| 状态监控 | 弹窗实时显示采集状态、已采数量 |

## 3. 技术架构

```
┌─────────────────────────────────────────────────────────┐
│  Teams 网页版 DOM                                          │
│  .fui-ChatMessageCompact / [data-tid=closed-caption-text] │
└───────────────────────────┬─────────────────────────────┘
                            │ 每 N 秒扫描
                            ▼
┌─────────────────────────────────────────────────────────┐
│  capture.js（content script，核心逻辑）                    │
│  captureCurrentState() → capturedMessages(Map)            │
│  finalizeCompleteMessages() → processedIds(Set)           │
│  downloadTranscript() → 拼接去重 → Blob 下载 .txt         │
└───────────────────────────▲─────────────────────────────┘
                            │ chrome.runtime 消息桥
┌─────────────────────────────────────────────────────────┐
│  popup.html / popup.js（弹窗 UI）                          │
│  开始/停止/手动抓取/清除/下载 + 状态显示                    │
└─────────────────────────────────────────────────────────┘
```

## 4. 模块说明

| 文件 | 职责 |
|------|------|
| `manifest.json` | 扩展配置，MV3，仅注入 `teams.microsoft.com` 与 `teams.cloud.microsoft` |
| `capture.js` | **核心** content script：DOM 抓取、状态管理、定稿检测、下载 |
| `popup.html` | 弹窗界面：设置、控制按钮、状态、快捷键提示 |
| `popup.js` | 弹窗逻辑：与 content script 通信、UI 刷新 |

## 5. 核心工作流（三阶段）

### 5.1 采集阶段

`captureCurrentState()` 按默认 10 秒间隔扫描 DOM 中所有 `.fui-ChatMessageCompact` 容器，提取：

- **发言人**：`[data-tid="author"]` 的文本
- **字幕内容**：`[data-tid="closed-caption-text"]` 的文本

同一 `uniqueId` 的字幕会被**原地更新**（Teams 会逐步补全一句话），而非追加新记录。

### 5.2 定稿阶段

`finalizeCompleteMessages()` 每 5 秒检查一次，一条字幕满足以下**两个条件**才被标记为定稿：

1. 文本以句末标点结尾（支持中英文 `.!?。！？`）
2. 最近 3 秒内未被更新（稳定性检查）

「稳定 3 秒」机制是为了等 Teams 把一句话完整吐出后再定稿，避免截断。

### 5.3 输出阶段

`downloadTranscript()` 将定稿字幕按时间排序，去重（同作者相邻相同内容只保留一条），拼接为以下格式后通过 Blob 触发下载：

```
[HH:MM:SS] 发言人
字幕内容
```

文件命名：`teams_captions_<会议名>_<时间戳>.txt`（自动下载加 `auto_` 前缀）。

## 6. uniqueId 去重策略

`getUniqueId()` 按优先级生成每条字幕的唯一标识：

1. `avatar-{id}` span 的 id（最可靠）
2. 作者名 + 稳定元素 id（WeakMap 绑定，抗滚动）
3. 作者名 + 容器序号

## 7. 使用方式

1. Chrome 打开 `chrome://extensions/` → 开启开发者模式 → 「加载已解压的扩展程序」→ 选择本文件夹
2. 打开 Teams Web 会议页面
3. 点击扩展图标，设置抓取间隔（默认 10 秒，范围 3–60 秒），点击 **Start**
4. 会议结束后自动下载；也可手动 `Alt+D`

### 7.1 自动开启实时字幕

扩展默认开启「自动开启字幕」：当检测到用户已进入会议（出现会议控制栏）但字幕未开启时，每 4 秒尝试一次，自动点击「更多操作 → 开启实时字幕」，直到字幕出现或重试达 10 次。

- 可在弹窗中通过「Auto-enable live captions」复选框开关，偏好持久化到 `storage`
- 也可 `Alt+E` 手动触发一次
- **说明**：Microsoft 已于 2026 年 8 月中旬起推出 Teams 原生「自动开启字幕」用户级设置（MC1447682），若你的租户已支持，可关闭本扩展的开关以避免重复操作；两者可并存不冲突

## 8. 权限与数据安全

- **权限**：`storage`、`activeTab`；主机权限仅限 `teams.microsoft.com` 与 `teams.cloud.microsoft`
- **数据**：所有字幕仅存于内存 `capturedMessages` Map，**刷新页面即丢失**；无任何网络上传

## 9. 已知限制

| # | 限制 | 根因 |
|---|------|------|
| 1 | 标签页最小化/切后台时字幕丢失 | Teams 在页面不可见时停止推送字幕；Chrome 节流后台定时器 |
| 2 | 中英标点混用切分边界 | `好的。谢谢。` 拆成两条，`好的，谢谢。` 算一条 |
| 3 | 会议名提取依赖 `document.title` 格式 | 不同语言/版本 Teams 标题格式可能变化 |
| 4 | ~~uniqueId 兜底用 DOM 坐标~~（已修复） | 已改用 WeakMap 稳定元素 id，抗滚动 |
| 5 | 自动开启字幕依赖菜单文案/结构 | Teams 更新菜单文案或 `data-tid` 时可能失效，需现场调试（`Alt+E`） |

## 10. 改进方案

### 10.1 限制 1：后台/最小化字幕丢失

**根治方案（推荐，但改动较大）**：改用 `chrome.tabCapture` 捕获标签页音频流，配合 Web Speech API（`SpeechRecognition`）做实时语音转文字，完全脱离 Teams DOM。

- 优点：后台也能跑、不丢字幕
- 代价：需 `tabCapture` 权限；SpeechRecognition 依赖语音服务，中国大陆网络可能受限；需保证 Teams 声音开启

**缓解方案（改动小，立即可做）**：

1. 用 `chrome.storage.session` 定期持久化 `capturedMessages`，刷新/重启可恢复，降低数据丢失
2. 在 `visibilitychange` 切到 hidden 时**立即**强制 finalize 并存 storage，而非等恢复后再处理

### 10.2 限制 2：标点混用切分

1. 引入「**发言人切换**」作为主要定稿信号：检测到新 `avatar id` 时，将上一发言人当前文本强制定稿，不再单纯依赖标点
2. 引入「**最小停顿窗口**」：连续两次采集文本未变且超过阈值（如 3 秒）即定稿，即使无句末标点
3. 对含多个句末标点的文本（`好的。谢谢。`），按标点拆分为多条或保留整条，做成可配置项

### 10.3 限制 3：会议名提取

1. 增加多个 fallback 正则，覆盖 `标题 | Microsoft Teams`、`Chat | 标题 | Microsoft Teams` 等多种格式
2. 尝试从会议标题的 DOM 元素读取（比 `document.title` 更稳定）
3. 在 popup 中提供「手动输入会议名」字段，覆盖自动提取结果并存入 storage

### 10.4 限制 4：uniqueId 兜底用 DOM 坐标 — ✅ 已完成

已改为「作者名 + WeakMap 稳定元素 id」，彻底规避滚动导致的坐标漂移（详见 6 节与 DEVELOPMENT.md）。

### 10.5 其他改进建议

1. **多格式导出**：支持 `.srt`（带序号 + 毫秒时间戳，便于回放对齐）和 `.json`（结构化，便于下游 skill 消费，对齐 `kb.json` 工作流）
2. **导出到剪贴板**：`navigator.clipboard` 一键复制
3. **导出到 JSON 供 AI 总结**：直接输出结构化字段 `{author, text, timestamp}`，作为会议纪要生成流程的标准输入

## 11. 技术栈约束

- Manifest V3（无法使用后台常驻 service worker 做长时间运行）
- 仅支持 `https://teams.microsoft.com/*` 与 `https://teams.cloud.microsoft/*`
- 数据存内存，刷新丢失（见 10.1 缓解方案）
