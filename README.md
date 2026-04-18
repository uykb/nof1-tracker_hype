# HL-CEX Tracker

实时监控 Hyperliquid 链上地址的合约持仓，自动同步到 Binance 期货账户。

## 工作原理

```
Hyperliquid 链上地址
        │
   ┌────┴─────┐
   │ WebSocket │  ← userFills 实时推送，收到即触发轮询
   │ REST 3-30s│  ← clearinghouseState 自适应轮询
   └────┬─────┘
        │
   PositionTracker          比对前后快照，检测 6 种变化 + 去重
        │
   RiskManager              价格容差 × 最小下单量 × 信号构建
        │                        quantity = HL持仓 × FIXED_RATIO
   TradeExecutor             市价单执行 + 止损单 + 孤儿单清理
        │
   BinanceService            Binance 期货 API（智能重试 + 预加载）
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
npm start -- follow --dashboard  # 跟单 + 启动 Web 面板
```

## 命令

### `follow` — 跟单

```bash
npm start -- follow                        # 等比跟单（1:1）
npm start -- follow -r 0.1                 # 跟 10% 仓位
npm start -- follow -a 0xabc...            # 指定地址（覆盖 .env）
npm start -- follow -p 2.0                 # 价格容差 2%
npm start -- follow --margin-type ISOLATED  # 逐仓模式
npm start -- follow --dry-run              # 试运行，不执行交易
npm start -- follow --dashboard            # 启动 Web 面板
npm start -- follow --dashboard --dashboard-port 8080  # 自定义端口
```

| 选项 | 简写 | 说明 | 默认 |
|------|------|------|------|
| `--address` | `-a` | 跟单地址 | .env |
| `--ratio` | `-r` | 仓位比例 | 1.0 |
| `--margin-type` | | ISOLATED / CROSSED | CROSSED |
| `--price-tolerance` | `-p` | 价格偏差上限 (%) | 1.0 |
| `--dry-run` | | 不执行交易 | false |
| `--log-level` | `-l` | 日志级别 | INFO |
| `--dashboard` | | 启用 Web 面板 | false |
| `--dashboard-port` | | 面板端口 | 3001 |

**FIXED_RATIO 举例**：源地址持有 HYPE LONG 100 个，`-r 0.1` 则跟单 10 个，`-r 1` 则跟 100 个。杠杆和保证金模式始终跟随源地址。

### `status` — 连接检查

```bash
npm start -- status
```

### `positions` — 查看持仓

```bash
npm start -- positions 0xYourAddress
```

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
- **最小下单量**：低于 Binance 最低 qty/notional 时自动跳过
- **下单去重**：同一 (symbol, side, timestamp) 不重复执行
- **并发安全**：WS事件和定时轮询互斥，不会重复下单
- **止损兜底**：全仓模式无强平价时，自动设入场价 -5% 止损
- **孤儿单清理**：每轮清理无对应持仓的止损止盈单
- **智能重试**：429限流/5xx重试、4xx不重试、-1021时间戳错误自动重同步
- **自适应轮询**：空闲时 30s，活动时 3s，WS 事件后立即轮询
- **配置校验**：地址格式、API Key、数值范围全部启动时校验

### 双通道信号获取

```
WebSocket userFills  ──→ fill 事件 ──→ 立即触发 REST 轮询
REST 3-30s 自适应    ──→ clearinghouseState ──→ 快照比对
```

WebSocket：50s 心跳、断线指数退避重连（1s→30s，最多 100 次）、重连后自动重订阅。

## Web Dashboard

使用 `--dashboard` 或设置 `DASHBOARD_PORT` 环境变量启动面板：

```bash
npm start -- follow --dashboard
DASHBOARD_PORT=8080 npm start -- follow --dashboard
```

面板功能：
- 实时仓位对比（HL vs Binance 并排表格）
- 最近交易记录
- 累计统计（PnL、胜率）
- 连接状态指示

API 端点：
- `GET /api/status` — 引擎完整状态快照
- `GET /api/positions` — HL + Binance 仓位
- `GET /api/history` — 最近交易记录
- `GET /api/config` — 当前配置
- `POST /api/control` — `{ "action": "start" | "stop" }`

## 配置

```env
# Hyperliquid
HYPERLIQUID_TARGET_ADDRESS=0x...     # 跟单地址（必填，0x开头42字符）
HYPERLIQUID_TESTNET=false
HYPERLIQUID_POLL_INTERVAL_MS=3000    # 最小轮询间隔

# Binance（必须启用 Futures 权限）
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_TESTNET=true                 # 先用测试网

# 交易
FIXED_RATIO=0.2                     # 0.2=20%, 1.0=等比
MARGIN_TYPE=CROSSED                  # ISOLATED / CROSSED
PRICE_TOLERANCE_PERCENT=1.0          # 价格容差 %
STOP_LOSS_PERCENT=5                  # 全仓无强平价时的默认止损 %

# 通知（可选）
DISCORD_WEBHOOK_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Dashboard（可选）
DASHBOARD_PORT=3001

# 日志
LOG_LEVEL=INFO                       # ERROR|WARN|INFO|DEBUG|VERBOSE
```

## 项目结构

```
src/
├── config/constants.ts          环境变量 → AppConfig（含校验）
├── types/index.ts               所有类型 + Symbol 映射 + parseHlPosition
├── utils/
│   ├── logger.ts                分级日志
│   ├── errors.ts                错误类 + isTransientError + retryWithBackoff
│   └── sleep.ts                 Promise sleep
├── services/
│   ├── hyperliquid-client.ts    HL REST API（retryWithBackoff）
│   ├── hyperliquid-ws.ts        HL WebSocket（自动重连+心跳）
│   ├── binance-service.ts        Binance 期货 API（智能重试+预加载exchangeInfo）
│   ├── position-tracker.ts      仓位快照比对 → PositionDelta[]
│   ├── risk-manager.ts           价格容差 + 最小下单量 + 信号构建
│   ├── trade-executor.ts         下单 / 平仓 / 止损兜底 / 清理孤儿单
│   ├── order-history.ts           JSON 原子持久化 + 去重 + PnL统计
│   ├── mirror-engine.ts           编排引擎（并发锁+自适应轮询+去重+通知）
│   ├── notifier.ts               Discord/Telegram 通知
│   └── dashboard-server.ts       Web 面板 + REST API + WebSocket
└── index.ts                      CLI（follow / status / positions）
```

## 风险提示

- 杠杆交易可能导致快速亏损，请谨慎使用
- 强烈建议先用 Binance Testnet 测试
- 链上数据可能有秒级延迟
- 市价单存在滑点，价格容差可控制
- 本工具仅需读取链上公开数据，不需要私钥
- API Key 安全：请使用 IP 白名单限制，不要泄露 .env 文件

## 许可证

MIT