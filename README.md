<div align="center">

# MyAgents

**活在你的电脑里，真正能干活的个人 Agent**

[中文](#中文) | [English](#english)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-13.0+-black.svg)](https://www.apple.com/macos/)
[![Windows](https://img.shields.io/badge/Windows-10+-blue.svg)](https://www.microsoft.com/windows/)
[![Website](https://img.shields.io/badge/Website-myagents.io-green.svg)](https://myagents.io)

**官网**: [https://myagents.io](https://myagents.io)

![MyAgents Screenshot](index.png)

</div>

---

<a name="中文"></a>

## 中文

MyAgents 是一款开源桌面端 AI Agent，同时具备「Claude Code」的强大 Agent 能力和灵活的 IM Bot 交互——二合一，一键安装零门槛。

截止 2026 年 1 月，AI 的智能飞速提升，已经让软件开发者首先变成了十倍百倍生产力的人。而 2026 年注定是智能丰裕的元年，我们希望这股 AI 的力量能被更多的人所掌握，无论你是学生、内容创作者、教育工作者、各种行业专家、产品经理等任何一个「想要去做些什么的人」。我们希望「MyAgents」能为你的电脑注入灵魂，让他成为你的思维放大器，将你的品味、想法变成现实对世界产生更大的影响。

### 快速体验
- 直接访问 https://myagents.io 点击下载安装包
- Mac 版本支持 Apple Silicon 和 Intel 芯片
- Win 版本支持 Windows 10 及以上

### 核心能力

- **图形界面零门槛** - Chrome 风格多标签页，每个 Tab 独立运行一个 Agent，真正的并行工作流
- **多模型自由切换** - Anthropic、DeepSeek、Moonshot、智谱、MiniMax、火山引擎、OpenRouter 等 9+ 供应商，按需选择，成本可控
- **Skills 技能系统** - 内置和自定义技能，一键触发常用操作，让 Agent 越用越懂你
- **MCP 工具集成** - 内置 MCP 协议支持（STDIO/HTTP/SSE），连接外部工具和数据源，Agent 能力可无限扩展
- **自定义 Agent** - 配置独立的 Prompt、工具、模型，打造专属 Agent
- **IM 聊天机器人** - 接入 Telegram / 飞书，多 Bot 管理、交互式权限审批、多媒体消息、定时任务
- **智能权限管理** - 行动/规划/自主三种模式，安全可控
- **本地数据，持续进化** - 所有对话、文件、记忆都存在本地，隐私有保障，API 直连供应商。随着使用积累，你的 AI 会越来越懂你
- **完全开源免费** - Apache-2.0 协议，代码完全公开

### 支持的模型供应商

| 供应商 | 模型 | 类型 |
|--------|------|------|
| Anthropic | Claude Sonnet 4.6, Opus 4.6, Haiku 4.5 | 订阅/API |
| DeepSeek | DeepSeek Chat, Reasoner | API |
| Moonshot | Kimi K2.5, K2 Thinking, K2 | API |
| 智谱 AI | GLM 5, 4.7, 4.5 Air | API |
| MiniMax | M2.5, M2.5 Lightning, M2.1, M2.1 Lightning | API |
| 火山引擎 | Ark Code Latest, Doubao Seed Code | API |
| ZenMux | ZenMux Auto, Gemini 3.1 Pro, Claude 4.6, Doubao Seed 2.0 等 | API |
| 硅基流动 | Kimi K2.5, GLM 4.7, DeepSeek V3.2, Step 3.5 Flash 等 | API |
| OpenRouter | GPT-5.2 Codex, GPT-5.2 Pro, Gemini 3 等多模型 | API |

### 系统要求

#### 最终用户

- **macOS 13.0 (Ventura)** 或更高版本，支持 Apple Silicon 和 Intel 芯片
- **Windows 10** 或更高版本

#### 开发者

- macOS 13.0+ / Windows 10+
- [Node.js](https://nodejs.org) (v18+)
- [Bun](https://bun.sh) - 开发时需要，最终用户无需安装
- [Rust](https://rustup.rs)

### 快速开始（开发者）

#### 安装

```bash
git clone https://github.com/hAcKlyc/MyAgents.git
cd MyAgents
./setup.sh
```

#### 构建

```bash
# Debug 构建 (含 DevTools)
./build_dev.sh

# 生产构建 (macOS DMG)
./build_macos.sh

# 生产构建 (Windows NSIS)
# PowerShell: .\build_windows.ps1
```

### 技术栈

| 组件 | 技术 |
|------|------|
| 前端 | React + TypeScript + TailwindCSS |
| 桌面 | Tauri v2 |
| 后端 | Bun + Claude Agent SDK (多实例) |
| 通信 | Rust HTTP/SSE Proxy (reqwest) |
| 拖拽 | @dnd-kit/sortable |

### 架构

**Session-Centric 多实例 Sidecar 架构** — 每个会话拥有独立的 Agent 进程，严格 1:1 隔离；多 Owner 共享机制让 Tab、定时任务、IM Bot 安全复用同一 Sidecar；Rust 代理层统一接管所有流量，零 CORS 问题；内置 Bun 运行时，用户无需安装任何依赖。

```
┌────────────────────────────────────────────────────────────────┐
│                        Tauri Desktop App                       │
├────────────────────────────────────────────────────────────────┤
│  React Frontend                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │  Chat 1  │  │  Chat 2  │  │ Settings │  │  IM Settings  │ │
│  │  Tab SSE │  │  Tab SSE │  │ 全局 API  │  │ 多 Bot 管理    │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬───────┘ │
│       │              │             │                │          │
├───────┼──────────────┼─────────────┼────────────────┼──────────┤
│  Rust │              │             │                │          │
│  ┌────┴──────────────┴───┐  ┌─────┴─────┐  ┌──────┴───────┐ │
│  │   SidecarManager     │  │  Global   │  │ ManagedImBots│ │
│  │  Session:Sidecar 1:1 │  │  Sidecar  │  │ Telegram/飞书 │ │
│  └────┬──────────┬───────┘  └───────────┘  └──────┬───────┘ │
│       ▼          ▼                                 ▼         │
│  Sidecar:31415  Sidecar:31416              Bot API Adapters  │
└────────────────────────────────────────────────────────────────┘
```

> 完整架构说明、Session 切换机制、Owner 生命周期等详见 [技术架构文档](specs/tech_docs/architecture.md)。

### 贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解贡献指南。

### 许可证

[Apache License 2.0](LICENSE)

---

<a name="english"></a>

## English

MyAgents is an open-source desktop AI Agent that combines the powerful Agent capabilities of "Claude Code" with flexible IM Bot interaction — two-in-one, one-click install, zero barrier.

For content creators, product managers, students, researchers, indie developers, AI enthusiasts — anyone who wants AI to get things done.

### Quick Download
- Visit https://myagents.io to download the installer
- Mac version supports both Apple Silicon and Intel chips
- Windows version supports Windows 10 and above

### Core Capabilities

- **Zero-Barrier GUI** - Chrome-style multi-tab interface, each Tab runs an independent Agent for true parallel workflows
- **Multi-Model Freedom** - Anthropic, DeepSeek, Moonshot, Zhipu, MiniMax, Volcengine, OpenRouter and 9+ providers, choose by need, control your cost
- **Skills System** - Built-in and custom skills, trigger common operations with one click, your Agent learns your habits
- **MCP Tool Integration** - Built-in MCP protocol support (STDIO/HTTP/SSE), connect external tools and data sources for unlimited extensibility
- **Custom Agents** - Configure dedicated prompts, tools, and models to build your own Agents
- **IM Chatbots** - Connect Telegram / Feishu (Lark), multi-bot management, interactive permission approval, multimedia messages, scheduled tasks
- **Smart Permissions** - Act / Plan / Auto modes for safety and control
- **Local Data, Continuous Evolution** - All conversations, files, and memories stay on your machine. API connects directly to providers. Your AI grows smarter the more you use it
- **Fully Open Source** - Apache-2.0 license, code fully open

### Supported Model Providers

| Provider | Models | Type |
|----------|--------|------|
| Anthropic | Claude Sonnet 4.6, Opus 4.6, Haiku 4.5 | Subscription/API |
| DeepSeek | DeepSeek Chat, Reasoner | API |
| Moonshot | Kimi K2.5, K2 Thinking, K2 | API |
| Zhipu AI | GLM 5, 4.7, 4.5 Air | API |
| MiniMax | M2.5, M2.5 Lightning, M2.1, M2.1 Lightning | API |
| Volcengine | Ark Code Latest, Doubao Seed Code | API |
| ZenMux | ZenMux Auto, Gemini 3.1 Pro, Claude 4.6, Doubao Seed 2.0 and more | API |
| SiliconFlow | Kimi K2.5, GLM 4.7, DeepSeek V3.2, Step 3.5 Flash and more | API |
| OpenRouter | GPT-5.2 Codex, GPT-5.2 Pro, Gemini 3 and more | API |

### System Requirements

#### End Users

- **macOS 13.0 (Ventura)** or later, Apple Silicon and Intel supported
- **Windows 10** or later

#### Developers

- macOS 13.0+ / Windows 10+
- [Node.js](https://nodejs.org) (v18+)
- [Bun](https://bun.sh) - Required for development only
- [Rust](https://rustup.rs)

### Quick Start (Developers)

#### Installation

```bash
git clone https://github.com/hAcKlyc/MyAgents.git
cd MyAgents
./setup.sh
```

#### Build

```bash
# Debug build (with DevTools)
./build_dev.sh

# Production build (macOS DMG)
./build_macos.sh

# Production build (Windows NSIS)
# PowerShell: .\build_windows.ps1
```

### Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | React + TypeScript + TailwindCSS |
| Desktop | Tauri v2 |
| Backend | Bun + Claude Agent SDK (multi-instance) |
| Communication | Rust HTTP/SSE Proxy (reqwest) |
| Drag & Drop | @dnd-kit/sortable |

### Architecture

**Session-Centric multi-instance Sidecar architecture** — each session owns an isolated Agent process with strict 1:1 mapping; a multi-owner mechanism lets Tabs, scheduled tasks, and IM Bots safely share the same Sidecar; the Rust proxy layer handles all traffic with zero CORS issues; Bun runtime is bundled — users install nothing.

```
┌────────────────────────────────────────────────────────────────┐
│                        Tauri Desktop App                       │
├────────────────────────────────────────────────────────────────┤
│  React Frontend                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │  Chat 1  │  │  Chat 2  │  │ Settings │  │  IM Settings  │ │
│  │  Tab SSE │  │  Tab SSE │  │Global API│  │ Multi-Bot Mgmt│ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬───────┘ │
│       │              │             │                │          │
├───────┼──────────────┼─────────────┼────────────────┼──────────┤
│  Rust │              │             │                │          │
│  ┌────┴──────────────┴───┐  ┌─────┴─────┐  ┌──────┴───────┐ │
│  │   SidecarManager     │  │  Global   │  │ ManagedImBots│ │
│  │  Session:Sidecar 1:1 │  │  Sidecar  │  │ TG / Feishu  │ │
│  └────┬──────────┬───────┘  └───────────┘  └──────┬───────┘ │
│       ▼          ▼                                 ▼         │
│  Sidecar:31415  Sidecar:31416              Bot API Adapters  │
└────────────────────────────────────────────────────────────────┘
```

> For full details on session switching, owner lifecycle, and communication flow, see the [Architecture Documentation](specs/tech_docs/architecture.md).

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

### License

[Apache License 2.0](LICENSE)
