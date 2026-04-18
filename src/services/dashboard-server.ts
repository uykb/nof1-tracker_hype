import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { MirrorEngine } from './mirror-engine';
import { AppConfig } from '../types';
import { logInfo, logError } from '../utils/logger';

export interface DashboardState {
  status: 'running' | 'stopped' | 'error';
  config: {
    targetAddress: string;
    ratio: number;
    marginType: string;
    priceTolerancePercent: number;
    binanceTestnet: boolean;
  };
  positions: {
    hl: Array<{ symbol: string; side: string; size: number; entryPrice: number; leverage: number; marginType: string }>;
    binance: Array<{ symbol: string; positionAmt: string; entryPrice: string; unrealizedProfit: string; leverage: string; marginType: string }>;
  };
  orderHistory: {
    totalOrders: number;
    totalTrades: number;
    recentOrders: Array<{
      id: string; symbol: string; side: string; quantity: number;
      price?: number; timestamp: number;
    }>;
  };
  cumStats: { totalPnl: number; totalCommission: number; winCount: number; lossCount: number; totalOrders: number };
  lastPollTime: number | null;
  wsConnected: boolean;
}

export class DashboardServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private engine: MirrorEngine | null = null;
  private config: AppConfig;
  private lastPollTime: number | null = null;

  constructor(private port: number = 3001, config: AppConfig) {
    this.config = config;
  }

  setEngine(engine: MirrorEngine): void {
    this.engine = engine;
    this.engine.on('started', () => this.broadcast({ type: 'status', data: { status: 'running' } }));
    this.engine.on('stopped', () => this.broadcast({ type: 'status', data: { status: 'stopped' } }));
  }

  async start(): Promise<void> {
    const express = await import('express');
    const app = express.default();
    app.use((await import('cors')).default());
    app.use(express.json());

    app.get('/api/status', async (_req, res) => {
      try {
        const state = await this.getState();
        res.json(state);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/positions', async (_req, res) => {
      try {
        const positions = await this.getPositions();
        res.json(positions);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/history', async (_req, res) => {
      try {
        const history = this.getOrderHistory();
        res.json(history);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/config', (_req, res) => {
      res.json({
        targetAddress: this.config.hyperliquid.targetAddress,
        ratio: this.config.trading.fixedRatio,
        marginType: this.config.trading.marginType,
        priceTolerancePercent: this.config.trading.priceTolerancePercent,
        binanceTestnet: this.config.binance.testnet,
        pollIntervalMs: this.config.hyperliquid.pollIntervalMs,
      });
    });

    app.post('/api/control', async (req, res) => {
      try {
        const { action } = req.body;
        if (!this.engine) {
          res.status(400).json({ error: 'Engine not set' });
          return;
        }
        if (action === 'start') {
          await this.engine.start();
          res.json({ ok: true, action: 'started' });
        } else if (action === 'stop') {
          await this.engine.stop();
          res.json({ ok: true, action: 'stopped' });
        } else {
          res.status(400).json({ error: `Unknown action: ${action}` });
        }
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(getDashboardHtml());
    });

    this.httpServer = app.listen(this.port, () => {
      logInfo(`[Dashboard] HTTP server listening on port ${this.port}`);
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      logInfo(`[Dashboard] WS client connected (total: ${this.clients.size})`);
      ws.on('close', () => {
        this.clients.delete(ws);
        logInfo(`[Dashboard] WS client disconnected (total: ${this.clients.size})`);
      });
      ws.on('error', (err) => {
        logError(`[Dashboard] WS error: ${err.message}`);
        this.clients.delete(ws);
      });
      this.sendInitialState(ws);
    });

    logInfo(`[Dashboard] Started on http://localhost:${this.port}`);
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.httpServer?.close();
    logInfo('[Dashboard] Stopped');
  }

  broadcast(event: { type: string; data: unknown }): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  updatePollTime(): void {
    this.lastPollTime = Date.now();
  }

  private async sendInitialState(ws: WebSocket): Promise<void> {
    try {
      const state = await this.getState();
      ws.send(JSON.stringify({ type: 'init', data: state }));
    } catch {
      ws.send(JSON.stringify({ type: 'init', data: { status: 'stopped' } }));
    }
  }

  private async getState(): Promise<DashboardState> {
    const positions = await this.getPositions();
    const history = this.getOrderHistory();
    const cumStats = this.engine ? this.engine.getOrderHistory().getCumulativeStats() : { totalPnl: 0, totalCommission: 0, winCount: 0, lossCount: 0, totalOrders: 0 };

    return {
      status: this.engine ? 'running' : 'stopped',
      config: {
        targetAddress: this.config.hyperliquid.targetAddress,
        ratio: this.config.trading.fixedRatio,
        marginType: this.config.trading.marginType,
        priceTolerancePercent: this.config.trading.priceTolerancePercent,
        binanceTestnet: this.config.binance.testnet,
      },
      positions,
      orderHistory: history,
      cumStats,
      lastPollTime: this.lastPollTime,
      wsConnected: false,
    };
  }

  private async getPositions(): Promise<DashboardState['positions']> {
    const hl: DashboardState['positions']['hl'] = [];
    const binance: DashboardState['positions']['binance'] = [];

    if (this.engine) {
      try {
        const hlPositions = this.engine.getTracker().getLastPositions();
        for (const [, pos] of hlPositions) {
          hl.push({ symbol: pos.symbol, side: pos.side, size: pos.size, entryPrice: pos.entryPrice, leverage: pos.leverage, marginType: pos.marginType });
        }
      } catch { /* tracker not ready */ }

      try {
        const bPositions = await this.engine.getBinance().getPositions();
        for (const p of bPositions) {
          binance.push(p);
        }
      } catch { /* binance not ready */ }
    }

    return { hl, binance };
  }

  private getOrderHistory(): DashboardState['orderHistory'] {
    if (!this.engine) {
      return { totalOrders: 0, totalTrades: 0, recentOrders: [] };
    }
    const history = this.engine.getOrderHistory();
    const stats = history.getStats();
    const orders = history.getProcessedOrders().slice(-50).reverse();
    return {
      totalOrders: stats.totalOrders,
      totalTrades: stats.totalTrades,
      recentOrders: orders.map((o) => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity,
        price: o.price,
        timestamp: o.timestamp,
      })),
    };
  }
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HL-CEX Tracker Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
.header h1{font-size:20px;color:#58a6ff}
.status-badge{padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600}
.status-running{background:#238636;color:#fff}
.status-stopped{background:#da3633;color:#fff}
.status-error{background:#d29922;color:#fff}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 24px}
@media(max-width:768px){.grid{grid-template-columns:1fr}}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
.card h2{font-size:14px;color:#8b949e;text-transform:uppercase;margin-bottom:12px}
.config-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.config-item{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #21262d}
.config-item .label{color:#8b949e;font-size:13px}
.config-item .value{color:#f0f6fc;font-size:13px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#8b949e;font-weight:600;padding:8px;border-bottom:1px solid #30363d}
td{padding:8px;border-bottom:1px solid #21262d}
.side-long{color:#3fb950}
.side-short{color:#f85149}
.events{max-height:300px;overflow-y:auto}
.event{padding:6px 0;border-bottom:1px solid #21262d;font-size:12px;font-family:monospace}
.event-time{color:#8b949e}
.controls{display:flex;gap:8px}
.btn{padding:8px 16px;border:1px solid #30363d;border-radius:6px;background:#21262d;color:#c9d1d9;cursor:pointer;font-size:13px;font-weight:600}
.btn:hover{background:#30363d}
.btn-start{border-color:#238636;color:#3fb950}
.btn-start:hover{background:#238636;color:#fff}
.btn-stop{border-color:#da3633;color:#f85149}
.btn-stop:hover{background:#da3633;color:#fff}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.stat{text-align:center;padding:8px}
.stat .num{font-size:24px;font-weight:700;color:#f0f6fc}
.stat .lbl{font-size:11px;color:#8b949e;text-transform:uppercase}
.stat-positive .num{color:#3fb950}
.stat-negative .num{color:#f85149}
</style>
</head>
<body>
<div class="header">
  <h1>HL → Binance Tracker</h1>
  <div>
    <span id="statusBadge" class="status-badge status-stopped">STOPPED</span>
    <span id="lastPoll" style="font-size:12px;color:#8b949e;margin-left:12px"></span>
  </div>
</div>
<div class="grid">
  <div class="card">
    <h2>Configuration</h2>
    <div id="configGrid" class="config-grid"></div>
  </div>
  <div class="card">
    <h2>Statistics</h2>
    <div id="statsGrid" class="stats"></div>
  </div>
  <div class="card">
    <h2>HL Positions</h2>
    <table><thead><tr><th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>Lev</th><th>Margin</th></tr></thead><tbody id="hlPositions"></tbody></table>
  </div>
  <div class="card">
    <h2>Binance Positions</h2>
    <table><thead><tr><th>Symbol</th><th>Amt</th><th>Entry</th><th>PnL</th><th>Lev</th><th>Margin</th></tr></thead><tbody id="binancePositions"></tbody></table>
  </div>
  <div class="card" style="grid-column:1/-1">
    <h2>Recent Orders</h2>
    <div class="events" id="recentOrders"></div>
  </div>
</div>
<script>
let ws;
const \$=id=>document.getElementById(id);
function connect(){
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(proto+'://'+location.host);
  ws.onmessage=e=>{
    try{const d=JSON.parse(e.data);handleMessage(d)}catch{}
  };
  ws.onclose=()=>setTimeout(connect,3000);
}
function handleMessage(msg){
  if(msg.type==='init'||msg.type==='status')updateState(msg.data);
}
function updateState(s){
  const b=\$('statusBadge');
  b.textContent=(s.status||'stopped').toUpperCase();
  b.className='status-badge status-'+(s.status||'stopped');
  if(s.config){
    const g=\$('configGrid');
    g.innerHTML=Object.entries(s.config).map(([k,v])=>'<div class="config-item"><span class="label">'+k+'</span><span class="value">'+String(v)+'</span></div>').join('');
  }
  if(s.cumStats)updateStats(s.cumStats);
  if(s.positions){
    renderPositions('hlPositions',s.positions.hl);
    renderPositions('binancePositions',s.positions.binance);
  }
  if(s.orderHistory)renderOrders(s.orderHistory.recentOrders||[]);
  if(s.lastPollTime)\$('lastPoll').textContent='Last poll: '+new Date(s.lastPollTime).toLocaleTimeString();
}
function updateStats(st){
  \$('statsGrid').innerHTML=
    '<div class="stat '+(st.totalPnl>=0?'stat-positive':'stat-negative')+'"><div class="num">'+st.totalPnl.toFixed(2)+'</div><div class="lbl">Total PnL</div></div>'+
    '<div class="stat"><div class="num">'+st.totalOrders+'</div><div class="lbl">Orders</div></div>'+
    '<div class="stat stat-positive"><div class="num">'+st.winCount+'</div><div class="lbl">Wins</div></div>'+
    '<div class="stat stat-negative"><div class="num">'+st.lossCount+'</div><div class="lbl">Losses</div></div>';
}
function renderPositions(id,positions){
  const tb=\$(id);
  tb.innerHTML=(positions||[]).map(p=>{
    const side=p.side||p.positionAmt;
    const cls=String(side).startsWith('LONG')||parseFloat(p.positionAmt||0)>0?'side-long':'side-short';
    return '<tr><td>'+((p.symbol||''))+'</td><td class="'+cls+'">'+side+'</td><td>'+(p.size||p.positionAmt||'')+'</td><td>'+(p.entryPrice||'')+'</td><td>'+(p.leverage||p.leverage||'')+'</td><td>'+(p.marginType||'')+'</td></tr>';
  }).join('');
}
function renderOrders(orders){
  \$('recentOrders').innerHTML=orders.slice(0,20).map(o=>'<div class="event"><span class="event-time">'+new Date(o.timestamp).toLocaleTimeString()+'</span> '+o.side+' '+o.quantity+' '+o.symbol+(o.price?' @ '+o.price.toFixed(2):'')+'</div>').join('');
}
connect();
setInterval(()=>fetch('/api/status').then(r=>r.json()).then(updateState).catch(()=>{}),5000);
</script>
</body>
</html>`;
}