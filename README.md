# HL-CEX Tracker - Hyperliquid 链上跟单系统

![TypeScript](https://img.shields.io/badge/typescript-5.0%2B-blue)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)

实时监控 Hyperliquid 链上指定地址的合约交易，自动同步到 Binance 期货账户执行。**链上信号源 → CEX 执行**的跟单架构。

## 架构

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

## 许可证

MIT License