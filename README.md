# HL-CEX Tracker - Hyperliquid 链上跟单系统

![TypeScript](https://img.shields.io/badge/typescript-5.0%2B-blue)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)

实时监控 Hyperliquid 链上指定地址的合约交易，自动同步到 Binance 期货账户执行。**链上信号源 → CEX 执行**的跟单架构。

---

## 重构说明

本项目从 `nof1-tracker` v1.0.3 重构为 `hl-cex-tracker` v2.0.0，核心变化是将信号源从 **NOF1 AI Agent 平台** 替换为 **Hyperliquid 链上地址监控**，实现"链上信号源 → CEX 执行"的全新跟单模式。

### 为什么要重构？

原项目通过轮询 `nof1.ai/api` 获取 AI Agent 的持仓快照来跟单。这种方式有本质局限：

1. **中心化依赖**：信号源依赖第三方 API，API 变更或宕机直接失效
2. **延迟不可控**：轮询间隔固定，无法捕捉瞬间的仓位变化
3. **策略受限**：只能跟 AI Agent 的开/平/换仓信号，无法追踪真实链上交易者
4. **循环依赖**：原代码存在 3 处循环依赖（`api-client ↔ analyze-api`、`futures-capital-manager ↔ analyze-api`、`types/api ↔ services`），架构不健康

重构后直接监控 Hyperliquid 链上地址，数据来源是链上真实交易，任何人都可以成为信号源。

### 架构对比

#### 旧架构 (v1.0.3)

```
NOF1 API (REST 轮询)
    │
    ▼
ApiClient.getAgentData()     ← 获取 AI Agent 持仓
    │
    ▼
ApiAnalyzer.followAgent()    ← 编排中心（也是类型导出中心，循环依赖）
    │
    ├──→ FollowService        ← 核心逻辑（依赖 ApiAnalyzer 的类型导出）
    ├──→ PositionManager       ← 仓位管理（同样通过 analyze-api 间接引用类型）
    ├──→ RiskManager           ← 风险评估
    ├──→ FuturesCapitalManager ← 保证金分配（循环依赖）
    ├──→ TradingExecutor       ← 交易执行
    ├──→ OrderHistoryManager   ← 历史记录
    └──→ ApiClient             ← API 客户端（循环依赖）
    │
    ▼
BinanceService → Binance API
```

**问题**：`analyze-api.ts` 同时承担类型导出和服务编排两个职责，导致 `api-client.ts`、`futures-capital-manager.ts` 与之形成循环依赖。`types/api.ts` 反向依赖 `services/risk-manager.ts` 和 `services/futures-capital-manager.ts`，违反了类型文件应该是叶子节点的原则。

#### 新架构 (v2.0.0)

```
Hyperliquid 链上地址
        │
   ┌────┴────┐
   │ WS 推送  │  ← userFills 实时事件（填充即触发轮询）
   │ REST 轮询 │  ← clearinghouseState 定时快照（3s 间隔）
   └────┬────┘
        │
  PositionTracker             ← 仓位状态追踪 & 6 种 Delta 检测
        │
  RiskManager                 ← 价格容差 + 信号构建
        │
  CapitalManager              ← 保证金分配
        │
  TradeExecutor               ← Binance 市价执行 + 止盈止损 + 孤儿单清理
        │
  OrderHistoryManager         ← JSON 持久化 + 去重
        │
  MirrorEngine (编排)         ← 统一调度，事件驱动
        │
  BinanceService              ← Binance 期货 API
```

**改进**：

1. **零循环依赖**：`types/index.ts` 是纯叶子模块，不依赖任何 service
2. **事件驱动**：WebSocket 填充事件即时触发轮询，不再仅依赖定时器
3. **单一职责**：每个 service 只做一件事，编排逻辑集中在 `MirrorEngine`

### 模块映射

| 旧模块 (v1) | 新模块 (v2) | 变化说明 |
|---|---|---|
| `services/api-client.ts` | `services/hyperliquid-client.ts` | NOF1 API → Hyperliquid REST API |
| — | `services/hyperliquid-ws.ts` | **新增**：HL WebSocket 连接（自动重连+心跳） |
| `services/binance-service.ts` | `services/binance-service.ts` | **保留**：适配新接口，核心逻辑不变 |
| `scripts/analyze-api.ts` | `services/mirror-engine.ts` | 编排中心重写，移除类型导出职责 |
| `services/follow-service.ts` | `services/position-tracker.ts` + `services/risk-manager.ts` | 拆分：位置追踪独立，信号构建独立 |
| `services/position-manager.ts` | `services/trade-executor.ts` | 重写：简化为开仓/平仓/止盈止损/孤儿单清理 |
| `services/futures-capital-manager.ts` | `services/capital-manager.ts` | 简化：移除多 Agent 分配逻辑，支持单地址 |
| `services/order-history-manager.ts` | `services/order-history.ts` | 简化：增加链上 fill 时间去重 |
| `services/profit-calculator.ts` | — | **移除**：原项目盈亏统计功能暂不包含 |
| `services/trade-history-service.ts` | — | **移除**：Binance 交易历史查询暂不包含 |
| `services/config-manager.ts` | `config/constants.ts` | 合并到配置常量 |
| `services/trading-executor.ts` | `services/trade-executor.ts` | 重写：整合原 position-manager 和 trading-executor |
| `types/api.ts` + 循环依赖 | `types/index.ts` | **关键改进**：纯类型叶子模块，零循环依赖 |
| `commands/follow.ts` | `index.ts` (follow 命令) | 简化：移除 agent 选择，改为地址参数 |
| `commands/agents.ts` | — | **移除**：不再有 AI Agent 列表 |
| `commands/profit.ts` | — | **移除**：盈亏分析暂不包含 |
| `commands/status.ts` | `index.ts` (status 命令) | 简化：检查 HL + Binance 连接 |

### 信号检测对比

| 旧信号 (v1) | 新信号 (v2) | 说明 |
|---|---|---|
| 孤儿订单清理 | 孤儿订单清理 | **保留**：每轮轮询前清理 |
| entry_oid 变更 | SIDE_FLIPPED | **改进**：直接检测多翻空/空翻多，不再依赖 OID |
| 新开仓 | NEW | **保留**：检测新 symbol 出现 |
| 平仓 | CLOSED | **保留**：检测仓位归零 |
| — | INCREASED | **新增**：检测加仓（size 增大但方向不变） |
| — | DECREASED | **新增**：检测减仓（size 减小但方向不变） |
| 止盈退出 | — | **移除**：不再基于 AI Agent 的 exit_plan 自动止盈 |
| TP/SL 自动下单 | 止盈止损（可选） | **改进**：使用链上持仓的 liquidationPrice 作为 SL 参考值 |
| — | LEVERAGE_CHANGED | **新增**：检测杠杆/保证金模式变更 |

### 数据流对比

#### 旧流程

```
每 30s 定时 → NOF1 API 获取 Agent 持仓
    → 重建上次状态（从 order-history.json）
    → 比对 entry_oid 变化
    → 生成 FollowPlan
    → 风险评估
    → 执行交易
```

#### 新流程

```
WebSocket userFills 事件 ──→ 立即触发轮询
每 3s 定时 ──→ HL REST 获取 clearinghouseState
    → 解析为 MirrorPosition[]
    → 与上次快照比对 → PositionDelta[]
    → RiskManager 构建信号 → TradeSignal
    → 价格容差检查
    → 保证金分配
    → 市价执行
    → 记录 OrderHistory
```

### 关键技术改进

| 方面 | 旧方案 | 新方案 |
|---|---|---|
| **信号获取** | REST 轮询 (30s 间隔) | WebSocket 实时推送 + REST 轮询 (3s 间隔) |
| **状态管理** | 从 JSON 重建上次状态 | 内存 Map + JSON 持久化 |
| **去重机制** | entry_oid + symbol | symbol + side + hlFillTime |
| **类型系统** | types/api.ts 循环依赖 services | types/index.ts 纯叶子模块 |
| **依赖数量** | 9 个 runtime 依赖（含 winston 未使用） | 6 个 runtime 依赖（精简） |
| **编排架构** | ApiAnalyzer 双重职责 | MirrorEngine 单一编排 |
| **Symbol 映射** | 硬编码 BTC→BTCUSDT | SYMBOL_MAP 字典（40+ 币种） |

---

## 快速开始

```bash
# 1. 安装依赖
npm install && npm run build

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入：
#   HYPERLIQUID_TARGET_ADDRESS=0x...  （要跟单的 HL 地址）
#   BINANCE_API_KEY=...               （币安 API Key）
#   BINANCE_API_SECRET=...             （币安 API Secret）

# 3. 检查连接状态
npm start -- status

# 4. 查看目标地址持仓
npm start -- positions 0xYourAddress

# 5. 启动跟单（试运行模式，不执行交易）
npm start -- follow --dry-run

# 6. 正式跟单
npm start -- follow
```

## 命令说明

### `follow` - 启动跟单

```bash
# 基本用法（使用 .env 中的地址）
npm start -- follow

# 指定地址（覆盖 .env）
npm start -- follow -a 0x1234...

# 设置总保证金
npm start -- follow -m 500

# 设置保证金模式
npm start -- follow --margin-type ISOLATED

# 设置价格容差（偏离源地址入场价超过此百分比不执行）
npm start -- follow -p 2.0

# 试运行（不执行真实交易）
npm start -- follow --dry-run

# 组合使用
npm start -- follow -a 0x... -m 200 --margin-type CROSSED -p 1.5 --dry-run
```

**选项**：

| 选项 | 简写 | 说明 | 默认值 |
|------|------|------|--------|
| `--address` | `-a` | Hyperliquid 地址 | .env 配置 |
| `--total-margin` | `-m` | 总保证金 (USDT) | 100 |
| `--margin-type` | | 保证金模式 | CROSSED |
| `--price-tolerance` | `-p` | 价格容差 (%) | 1.0 |
| `--max-position-size` | | 最大仓位数 (USDT) | 1000 |
| `--dry-run` | | 试运行，不执行交易 | false |
| `--log-level` | `-l` | 日志级别 | INFO |

### `status` - 检查连接

```bash
npm start -- status
```

检查 Hyperliquid API 和 Binance API 的连接状态，显示目标地址持仓概要和币安账户余额。

### `positions <address>` - 查看持仓

```bash
npm start -- positions 0xYourAddress
```

查看指定地址在 Hyperliquid 上的当前持仓，包括方向、数量、入场价、杠杆、未实现盈亏和强平价格。

## 跟单策略详解

系统检测 6 种仓位变化信号：

| 信号 | 触发条件 | 执行动作 |
|------|---------|---------|
| **NEW** | 源地址新开仓 | 同方向市价开仓 |
| **CLOSED** | 源地址平仓 | 同方向市价平仓 |
| **INCREASED** | 源地址加仓（size 增大，方向不变） | 同方向加仓 |
| **DECREASED** | 源地址减仓（size 减小，方向不变） | 同方向减仓 |
| **SIDE_FLIPPED** | 源地址多翻空/空翻多 | 先平旧仓再开新仓 |
| **LEVERAGE_CHANGED** | 源地址调杠杆或改保证金模式 | 修改 Binance 杠杆/模式 |

### 风控机制

1. **价格容差检查**：源地址入场价与当前市价偏差超过阈值时跳过（默认 1%）
2. **最大仓位限制**：单仓名义价值不超过设定上限（默认 1000 USDT）
3. **孤儿单清理**：每轮轮询前清理无对应持仓的止盈止损单
4. **保证金检查**：余额不足时自动缩减仓位至 95% 可用余额，仍不足则跳过
5. **杠杆警告**：杠杆超过 20x 时输出警告日志

### 执行流程

```
启动
  │
  ├── 初始化 Binance 连接
  ├── 加载历史订单
  ├── 获取 HL 地址当前持仓快照
  ├── 连接 HL WebSocket → 订阅 userFills
  │
  └── 主循环（3s 间隔 + WS 事件触发）
        │
        ├── 清理孤儿订单
        │
        ├── REST 获取 clearinghouseState
        │     │
        │     ▼
        │   解析为 MirrorPosition[]
        │     │
        │     ▼
        │   与上次快照比对 → PositionDelta[]
        │
        ├── 遍历 Delta 列表：
        │     │
        │     ├── RiskManager 构建信号 → TradeSignal
        │     │
        │     ├── 价格容差检查（市价 vs 源地址入场价）
        │     │
        │     ├── CapitalManager 分配保证金 → 计算数量
        │     │
        │     ├── TradeExecutor 执行市价单
        │     │
        │     └── 记录 OrderHistory + JSON 持久化
        │
        └── 等待下一轮
```

### WebSocket 事件驱动

```
HL WebSocket userFills
      │
      ▼
  收到 fill 事件
      │
      ▼
  立即触发 REST 轮询（不等定时器）
      │
      ▼
  检测到仓位变化 → 执行跟单
```

WebSocket 连接管理：
- 每 50s 发送心跳 ping
- 断线自动重连（指数退避，1s → 30s，最多 100 次）
- 重连后自动重新订阅 userFills
- WebSocket 连接失败时自动降级为纯 REST 轮询模式

## 项目结构

```
src/
├── config/
│   └── constants.ts          # 配置常量 + 环境变量构建
├── types/
│   └── index.ts              # 所有类型定义（零循环依赖）
│                                - HL 链上类型（HlPosition, HlFill, HlClearinghouseState...）
│                                - 镜像交易类型（MirrorPosition, PositionDelta, TradeSignal...）
│                                - 执行结果类型（ExecutionResult, StopOrderResult...）
│                                - 配置类型（AppConfig, FollowOptions...）
│                                - Symbol 映射（HL coin ↔ Binance symbol）
├── utils/
│   ├── logger.ts              # 分级日志（ERROR/WARN/INFO/DEBUG/VERBOSE）
│   └── errors.ts              # 错误类 + 重试工具（retryWithBackoff）
├── services/
│   ├── hyperliquid-client.ts  # HL REST API 客户端
│   │                            - getClearinghouseState() 获取地址持仓
│   │                            - getUserFills() 获取成交记录
│   │                            - getUserFillsByTime() 按时间查询成交
│   │                            - getOpenOrders() 获取挂单
│   │                            - getMeta() 获取交易对元数据
│   ├── hyperliquid-ws.ts      # HL WebSocket 客户端
│   │                            - 自动重连（指数退避，最多 100 次）
│   │                            - 心跳保活（50s ping）
│   │                            - 订阅管理（subscribeToFills/unsubscribeFromFills）
│   │                            - 事件发射：fill / connected / disconnected / error
│   ├── binance-service.ts      # Binance 期货 API（HMAC-SHA256 签名）
│   │                            - 下单/撤单/查仓/设杠杆/设保证金模式
│   │                            - 自动时间同步 + 时间戳错误重试
│   │                            - 交易对精度缓存
│   ├── position-tracker.ts    # 仓位状态追踪 & Delta 检测引擎
│   │                            - initialize() 初始化基线快照
│   │                            - detectChanges() 比对变化
│   │                            - 支持 6 种 Delta 类型检测
│   ├── trade-executor.ts      # 交易执行引擎
│   │                            - executeSignal() 执行跟单信号
│   │                            - closePosition() 平仓
│   │                            - placeStopOrders() 设置止盈止损
│   │                            - cleanOrphanedOrders() 清理孤儿单
│   │                            - 自动初始化 symbol 配置（杠杆+保证金模式+精度）
│   ├── risk-manager.ts        # 风险评估 & 信号构建
│   │                            - buildSignalFromDelta() 将仓位变化转为交易信号
│   │                            - checkPriceTolerance() 价格容差检查
│   │                            - assessRisk() 风险评估
│   ├── capital-manager.ts      # 保证金分配 & 仓位计算
│   │                            - allocateForSinglePosition() 单仓分配
│   │                            - allocateForDelta() 增量分配
│   │                            - 余额不足时自动缩减
│   ├── order-history.ts        # 订单历史持久化（JSON 文件）
│   │                            - 去重（symbol + side + hlFillTime）
│   │                            - 定期清理过期记录
│   └── mirror-engine.ts        # 核心编排引擎
│                                - WebSocket + REST 联动
│                                - 6 种 Delta 处理路由
│                                - 优雅关闭（SIGINT/SIGTERM）
└── index.ts                    # CLI 入口
                                 - follow: 启动跟单
                                 - status: 检查连接
                                 - positions: 查看持仓
```

## 配置参考

```env
# Hyperliquid
HYPERLIQUID_TARGET_ADDRESS=0x...     # 必填：跟单目标地址
HYPERLIQUID_TESTNET=false              # 测试网开关
HYPERLIQUID_POLL_INTERVAL_MS=3000      # REST 轮询间隔（毫秒）

# Binance
BINANCE_API_KEY=...                    # 必填：币安 API Key
BINANCE_API_SECRET=...                 # 必填：币安 API Secret
BINANCE_TESTNET=true                   # 强烈建议先用测试网

# 交易参数
MAX_POSITION_SIZE=1000                 # 最大仓位 USDT
DEFAULT_LEVERAGE=10                    # 默认杠杆
TOTAL_MARGIN_USDT=100                 # 跟单总保证金
MARGIN_TYPE=CROSSED                    # 保证金模式（ISOLATED / CROSSED）
PRICE_TOLERANCE_PERCENT=1.0            # 价格容差 %
RISK_PERCENTAGE=2.0                    # 风险百分比

# 日志
LOG_LEVEL=INFO                         # ERROR|WARN|INFO|DEBUG|VERBOSE
```

## 风险提示

- **⚠️ 合约交易风险**：杠杆交易可能导致快速亏损，请谨慎使用
- **🧪 先用测试网**：强烈建议先在 Binance Testnet 测试
- **📊 链上延迟**：WebSocket 推送 + REST 轮询，可能存在秒级延迟
- **💸 滑点风险**：市价单可能有滑点，通过价格容差控制
- **🔄 重连机制**：WebSocket 断线自动重连（指数退避，最多 100 次）
- **🔒 私钥安全**：本工具仅需读取链上公开数据，**不需要**私钥

## 开发

```bash
npm install       # 安装依赖
npm run dev       # 开发模式（ts-node）
npm run build     # 编译 TypeScript
npm run lint      # 代码检查
npm run format    # 代码格式化
```

## 从 v1 迁移

如果你从 `nof1-tracker` v1 升级，注意以下破坏性变更：

1. **环境变量**：移除 `NOF1_API_BASE_URL`，新增 `HYPERLIQUID_TARGET_ADDRESS`、`HYPERLIQUID_TESTNET`、`HYPERLIQUID_POLL_INTERVAL_MS`、`TOTAL_MARGIN_USDT`、`MARGIN_TYPE`、`PRICE_TOLERANCE_PERCENT`
2. **命令变更**：
   - `follow <agent>` → `follow [--address <addr>]`（不再跟 Agent，改为跟链上地址）
   - 移除 `agents` 命令
   - 移除 `profit` 命令
   - 新增 `positions <address>` 命令
3. **数据目录**：`data/order-history.json` 格式不兼容，需要清空重新开始
4. **依赖变更**：移除 `winston`、`querystring`，新增 `ws`

## 许可证

MIT License