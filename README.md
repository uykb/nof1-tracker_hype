# HL-CEX Tracker

实时监控 Hyperliquid 链上地址的合约持仓，自动同步到 Binance 期货账户。

## 工作原理

```
Hyperliquid 链上地址
        │
   ┌────┴─────┐
   │ WebSocket │  ← userFills 实时推送，收到即触发轮询
   │ REST 3s   │  ← clearinghouseState 定时快照
   └────┬─────┘
        │
   PositionTracker          比对前后快照，检测 6 种变化
        │
   RiskManager              价格容差检查 × 信号构建
        │                        quantity = HL持仓 × FIXED_RATIO
   TradeExecutor             市价单执行 + 止损单 + 孤儿单清理
        │
   BinanceService            Binance 期货 API
```

核心逻辑：**跟单数量 = 源地址持仓数量 × FIXED_RATIO**，杠杆和保证金模式跟随源地址。

## 快速开始

```bash
npm install && npm run build

cp .env.example .env
# 编辑 .env 填入 HYPERLIQUID_TARGET_ADDRESS、BINANCE_API_KEY、BINANCE_API_SECRET

npm start -- status          # 检查连接
npm start -- positions 0x..  # 查看目标地址持仓
npm start -- follow --dry-run # 试运行
npm start -- follow           # 正式跟单
```

## 命令

### `follow` — 跟单

```bash
npm start -- follow                        # 等比跟单（1:1）
npm start -- follow -r 0.1                 # 跟 10% 仓位
npm start -- follow -r 2.0                 # 跟 2 倍仓位
npm start -- follow -a 0xabc...            # 指定地址（覆盖 .env）
npm start -- follow -p 2.0                 # 价格容差 2%
npm start -- follow --margin-type ISOLATED  # 逐仓模式
npm start -- follow --dry-run              # 试运行，不执行交易
```

| 选项 | 简写 | 说明 | 默认 |
|------|------|------|------|
| `--address` | `-a` | 跟单地址 | .env |
| `--ratio` | `-r` | 仓位比例 | 1.0 |
| `--margin-type` | | ISOLATED / CROSSED | CROSSED |
| `--price-tolerance` | `-p` | 价格偏差上限 (%) | 1.0 |
| `--dry-run` | | 不执行交易 | false |
| `--log-level` | `-l` | 日志级别 | INFO |

**FIXED_RATIO 举例**：源地址持有 HYPE LONG 100 个，`-r 0.1` 则跟单 10 个，`-r 1` 则跟 100 个，`-r 2` 则跟 200 个。杠杆和保证金模式始终跟随源地址。

### `status` — 连接检查

```bash
npm start -- status
```

显示 Hyperliquid 持仓概况和 Binance 账户余额。

### `positions` — 查看持仓

```bash
npm start -- positions 0xYourAddress
```

显示指定地址在 Hyperliquid 上的持仓详情。

## 跟单策略

检测 6 种仓位变化：

| 信号 | 说明 | 动作 |
|------|------|------|
| NEW | 源地址新开仓 | 同方向市价开仓 |
| CLOSED | 源地址平仓 | 同方向市价平仓 |
| INCREASED | 源地址加仓 | 同方向加仓 |
| DECREASED | 源地址减仓 | 同方向减仓 |
| SIDE_FLIPPED | 源地址多翻空或空翻多 | 先平旧仓再开新仓 |
| LEVERAGE_CHANGED | 源地址调杠杆或改保证金模式 | 同步修改 Binance 设置 |

### 风控

- **价格容差**：当前市价偏离源地址入场价超过阈值（默认 1%）时跳过
- **孤儿单清理**：每轮清理无对应持仓的止损止盈单
- **杠杆跟随**：始终使用源地址的杠杆，不设默认值回退
- **保证金模式跟随**：始终使用源地址的保证金模式

### 双通道信号获取

```
WebSocket userFills  ──→ fill 事件 ──→ 立即触发 REST 轮询
REST 3s 定时        ──→ clearinghouseState ──→ 快照比对
```

WebSocket 连接管理：50s 心跳、断线指数退避重连（1s→30s，最多 100 次）、重连后自动重订阅、连接失败时降级为纯轮询。

## 配置

```env
# Hyperliquid
HYPERLIQUID_TARGET_ADDRESS=0x...     # 跟单地址（必填）
HYPERLIQUID_TESTNET=false
HYPERLIQUID_POLL_INTERVAL_MS=3000

# Binance（必须启用 Futures 权限）
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_TESTNET=true                 # 先用测试网

# 交易
FIXED_RATIO=1.0                      # 1.0=等比, 0.1=10%, 2.0=2倍
MARGIN_TYPE=CROSSED                  # ISOLATED / CROSSED
PRICE_TOLERANCE_PERCENT=1.0          # 价格容差 %

# 日志
LOG_LEVEL=INFO                       # ERROR|WARN|INFO|DEBUG|VERBOSE
```

只有 3 个交易参数：`FIXED_RATIO` 控制仓位大小，`MARGIN_TYPE` 是设置失败时的回退值（实际跟随源地址），`PRICE_TOLERANCE_PERCENT` 控制滑点保护。

## 项目结构

```
src/
├── config/constants.ts          环境变量 → AppConfig
├── types/index.ts               所有类型 + Symbol 映射
├── utils/
│   ├── logger.ts                分级日志
│   └── errors.ts                错误类 + retryWithBackoff
├── services/
│   ├── hyperliquid-client.ts    HL REST API
│   ├── hyperliquid-ws.ts        HL WebSocket（自动重连+心跳）
│   ├── binance-service.ts        Binance 期货 API
│   ├── position-tracker.ts      仓位快照比对 → PositionDelta[]
│   ├── risk-manager.ts           价格容差 + 信号构建（quantity = HL × ratio）
│   ├── trade-executor.ts         下单 / 平仓 / 止损 / 清理孤儿单
│   ├── order-history.ts           JSON 持久化 + 去重
│   └── mirror-engine.ts           编排引擎（WS+REST 联动，事件驱动）
└── index.ts                      CLI（follow / status / positions）
```

## 风险提示

- 杠杆交易可能导致快速亏损，请谨慎使用
- 强烈建议先用 Binance Testnet 测试
- 链上数据可能有秒级延迟
- 市价单存在滑点，价格容差可控制
- 本工具仅需读取链上公开数据，不需要私钥

## 许可证

MIT