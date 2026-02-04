# AI Agent 日历集成方案研究

> 调研日期：2026-02-04
> 目标：为 MyAgents 的 AI 接入日历能力，实现读取/管理 TODO、事件等

---

## 一、日历领域核心协议与标准

### 1.1 iCalendar (RFC 5545)

**iCalendar** 是日历数据交换的**事实标准格式**，文件扩展名为 `.ics`。

- **RFC 5545**：定义日历数据格式（事件、待办、日记、空闲/忙碌信息）
- **RFC 5546 (iTIP)**：日程安排交互协议（会议邀请、回复、取消）
- **RFC 6047 (iMIP)**：基于邮件的日程互操作协议

**数据格式变体**：
| 格式 | RFC | 说明 |
|------|-----|------|
| iCalendar | RFC 5545 | 原始文本格式 (.ics) |
| xCal | RFC 6321 | XML 格式 |
| jCal | RFC 7265 | **JSON 格式（推荐 AI 使用）** |

### 1.2 CalDAV (RFC 4791)

**CalDAV** 是基于 WebDAV 的日历访问协议，是**跨平台日历同步的通用标准**。

- 支持 CRUD 操作（创建、读取、更新、删除）
- 使用 iCalendar 格式存储数据
- 支持日程调度 (RFC 6638)
- 支持 DNS 服务发现 (RFC 6764)

**CalDAV 的优势**：
- ✅ **跨平台标准**：Apple Calendar、Google Calendar、Nextcloud 等都支持
- ✅ **不依赖厂商**：可对接任意 CalDAV 服务器
- ✅ **数据所有权**：可自建服务器，数据完全可控

**CalDAV 的局限**：
- ❌ 比 REST API 复杂（基于 WebDAV/XML）
- ❌ 各厂商实现程度不一（Google 的 CalDAV 支持不完整）
- ❌ 实时推送支持较弱

---

## 二、主流日历服务 API 对比

### 2.1 Google Calendar

| 方案 | 协议 | 优势 | 劣势 |
|------|------|------|------|
| **Google Calendar API** | REST/JSON | 功能完整、文档详尽、支持 Webhook | 仅限 Google 生态 |
| CalDAV | CalDAV | 跨平台标准 | 功能受限、文档少、不支持高级特性 |

**推荐**：优先使用 **Google Calendar API**。

**Service Account 方案（推荐给 AI）**：
1. 创建 Google Cloud 项目
2. 启用 Calendar API
3. 创建 Service Account
4. 将日历共享给 Service Account 邮箱
5. 使用 JSON 密钥文件认证

```
Service Account 邮箱格式：
xxx@project-id.iam.gserviceaccount.com
```

### 2.2 Apple iCloud Calendar

| 方案 | 说明 |
|------|------|
| CalDAV | **唯一官方支持的方式** |
| REST API | ❌ 不存在 |
| OAuth | ❌ 不支持，需使用 App-Specific Password |

**限制**：
- 无 Webhook（需轮询 + sync-collection）
- 不支持 PATCH（需完整 PUT）
- 邀请由 iCloud 自动处理

**CalDAV 端点**：`caldav.icloud.com`

**推荐库**：[tsdav](https://github.com/natelindev/tsdav) (JavaScript/TypeScript)

### 2.3 Microsoft Outlook/Exchange

| 方案 | 适用场景 | 状态 |
|------|----------|------|
| **Microsoft Graph API** | Microsoft 365 / Exchange Online | ✅ 推荐 |
| Exchange Web Services (EWS) | Exchange 本地部署 | ⚠️ 2026.10 停用在线版 |
| CalDAV | - | ❌ 不支持 |

**重要时间线**：
- 2026 年 10 月 1 日：EWS 将被禁止访问 Exchange Online
- 本地 Exchange Server 仍支持 EWS

### 2.4 自建 CalDAV 服务器

| 方案 | 特点 | 推荐场景 |
|------|------|----------|
| **Radicale** | 轻量、Python、无数据库、文件存储 | 个人/小团队、AI 专用日历 |
| **Nextcloud** | 全功能、Web UI、生态丰富 | 团队协作、需要 Web 界面 |
| Baïkal | 轻量、PHP | 简单部署 |
| SOGo | 企业级、群组日历 | 企业环境 |

**Radicale 特点**（推荐给 AI 专用日历）：
```yaml
优点:
  - 极简部署（Python + 配置文件）
  - 无数据库依赖
  - Docker 友好
  - 资源占用极低

缺点:
  - 无 Web UI（仅管理界面）
  - 日历共享功能有限
  - RFC 实现不完整
```

---

## 三、为 AI 创建独立日历的方案

### 方案 A：Google Calendar 辅助日历

**架构**：
```
用户 Google 账号
├── 主日历（个人使用）
└── AI 日历（与 Service Account 共享）
        ↑
    AI Agent 通过 Service Account 读写
```

**实现步骤**：
1. 在 Google Calendar 创建新日历（如"AI 任务"）
2. 将该日历共享给 Service Account（读写权限）
3. AI 通过 Service Account 访问该日历
4. 用户可在手机/电脑上查看该日历

**优势**：
- ✅ 与用户日历自然集成
- ✅ 多端同步
- ✅ 无需自建服务器

### 方案 B：自建 CalDAV 服务器

**架构**：
```
Radicale Server (Docker)
├── /user/calendars/personal/    # 用户日历
└── /user/calendars/ai-tasks/    # AI 专用日历
        ↑
    AI Agent 通过 CalDAV 协议读写
```

**实现步骤**：
1. Docker 部署 Radicale
2. 创建 AI 专用日历
3. 配置 htpasswd 认证
4. （可选）配置反向代理 + HTTPS

**优势**：
- ✅ 完全数据所有权
- ✅ 无第三方依赖
- ✅ 隐私保护最佳

**劣势**：
- ❌ 需要自建/运维
- ❌ 多端同步需额外配置

### 方案 C：混合方案（推荐）

**架构**：
```
用户手机/电脑
    ↓ 订阅 CalDAV
本地 Radicale (localhost:5232)
    ↑
AI Agent 读写
    ↓ 可选：单向同步
Google Calendar（备份/多端查看）
```

---

## 四、MCP 集成方案（针对 Claude/MyAgents）

### 4.1 现有 MCP 日历服务器

| 项目 | 支持平台 | 功能 |
|------|----------|------|
| [google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) | Google | 多账号、创建/更新/删除、智能调度 |
| [mcp-google-calendar](https://github.com/guinacio/mcp-google-calendar) | Google | 基础 CRUD、空闲时间查询 |
| Apple Calendar MCP | macOS | 本地日历读写 |

### 4.2 MyAgents 集成建议

**Phase 1：对接现有 MCP 服务器**
```json
// claude_mcp_config.json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["google-calendar-mcp"],
      "env": {
        "GOOGLE_CREDENTIALS_PATH": "~/.config/myagents/google-calendar-creds.json"
      }
    }
  }
}
```

**Phase 2：开发通用 CalDAV MCP 服务器**
- 支持任意 CalDAV 服务器
- 支持 iCloud、自建 Radicale、Fastmail 等
- 实现 TODO (VTODO) 支持

### 4.3 核心功能需求

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 查看今日/本周事件 | P0 | 读取 VEVENT |
| 查看待办列表 | P0 | 读取 VTODO |
| 创建待办 | P0 | 创建 VTODO |
| 完成待办（打勾） | P0 | 更新 STATUS=COMPLETED |
| 添加评论/备注 | P1 | 更新 COMMENT 属性 |
| 创建事件 | P1 | 创建 VEVENT |
| 设置提醒 | P2 | 添加 VALARM 组件 |

---

## 五、数据格式示例

### 5.1 iCalendar 待办 (VTODO)

```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//MyAgents//AI Calendar//EN
BEGIN:VTODO
UID:task-001@myagents.local
DTSTAMP:20260204T100000Z
SUMMARY:完成日历集成调研
DESCRIPTION:调研 CalDAV 协议和 API 对比
DUE:20260205T180000Z
STATUS:IN-PROCESS
PRIORITY:1
PERCENT-COMPLETE:50
COMMENT:AI Agent 已完成基础调研
END:VTODO
END:VCALENDAR
```

### 5.2 jCal (JSON 格式)

```json
["vcalendar",
  [
    ["version", {}, "text", "2.0"],
    ["prodid", {}, "text", "-//MyAgents//AI Calendar//EN"]
  ],
  [
    ["vtodo",
      [
        ["uid", {}, "text", "task-001@myagents.local"],
        ["summary", {}, "text", "完成日历集成调研"],
        ["status", {}, "text", "IN-PROCESS"],
        ["percent-complete", {}, "integer", 50]
      ],
      []
    ]
  ]
]
```

---

## 六、推荐方案总结

### 快速起步（Phase 1）

| 用户场景 | 推荐方案 |
|----------|----------|
| 使用 Google Calendar | 集成 Google Calendar MCP 服务器 |
| 使用 Apple 生态 | 集成 Apple Calendar MCP 服务器 |
| 需要隐私保护 | 本地部署 Radicale |

### 长期目标（Phase 2）

**开发通用 CalDAV MCP 服务器**：
- 一套代码对接所有 CalDAV 服务
- 支持 Google Calendar、iCloud、Fastmail、自建服务器
- 实现完整的 VEVENT + VTODO 支持

### 关于"AI 专用日历"

**推荐做法**：

1. **Google 用户**：在 Google Calendar 创建新日历"AI Tasks"，共享给 Service Account
2. **Apple 用户**：在日历 App 创建新日历"AI Tasks"
3. **隐私优先**：本地运行 Radicale，AI 直接读写

**共享机制**：
- Google：通过 ACL API 或 UI 共享
- CalDAV：通过服务器配置共享
- Apple：通过 iCloud 共享设置

---

## 七、参考资源

### 协议规范
- [RFC 5545 - iCalendar](https://datatracker.ietf.org/doc/html/rfc5545)
- [RFC 4791 - CalDAV](https://datatracker.ietf.org/doc/html/rfc4791)
- [RFC 6638 - CalDAV Scheduling](https://icalendar.org/CalDAV-Scheduling-RFC-6638/1-introduction.html)
- [CalConnect Standards](https://devguide.calconnect.org/Appendix/Standards/)

### API 文档
- [Google Calendar API](https://developers.google.com/calendar)
- [Google CalDAV Guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)
- [Microsoft Graph Calendar API](https://learn.microsoft.com/en-us/graph/api/resources/calendar-overview)
- [Apple CalDAV Documentation](https://developer.apple.com/documentation/devicemanagement/caldav)

### 开源项目
- [Radicale](https://github.com/Kozea/Radicale) - 轻量 CalDAV 服务器
- [tsdav](https://github.com/natelindev/tsdav) - TypeScript CalDAV 客户端
- [google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) - Google Calendar MCP 服务器

### 实践指南
- [iCloud CalDAV Integration](https://www.onecal.io/blog/how-to-integrate-icloud-calendar-api-into-your-app)
- [Google Service Account 日历访问](https://medium.com/product-monday/accessing-google-calendar-api-with-service-account-a99aa0f7f743)
- [Building CalDAV Server](https://rfrancocantero.medium.com/building-a-self-hosted-caldav-server-the-technical-reality-behind-calendar-sharing-9a930af28ff0)
