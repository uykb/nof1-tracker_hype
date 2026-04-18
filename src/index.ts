import { Command } from 'commander';
import dotenv from 'dotenv';
import { buildConfigFromEnv } from './config/constants';
import { setLogLevel } from './utils/logger';
import { MirrorEngine } from './services/mirror-engine';
import { DashboardServer } from './services/dashboard-server';

dotenv.config();

const program = new Command();

program
  .name('hl-cex-tracker')
  .description('Mirror Hyperliquid on-chain positions to Binance Futures')
  .version('2.0.0');

program
  .command('follow')
  .description('Start mirroring positions from Hyperliquid to Binance')
  .option('-a, --address <address>', 'Hyperliquid address to follow (overrides env)')
  .option('-r, --ratio <number>', 'Position ratio vs HL (1.0=equal, 0.1=10%)', parseFloat)
  .option('--margin-type <type>', 'Margin type: ISOLATED or CROSSED', 'CROSSED')
  .option('-p, --price-tolerance <percent>', 'Max price deviation % to still execute', parseFloat)
  .option('--dry-run', 'Simulate without executing trades', false)
  .option('-l, --log-level <level>', 'Log level: ERROR|WARN|INFO|DEBUG|VERBOSE', 'INFO')
  .option('--dashboard', 'Enable web dashboard')
  .option('--dashboard-port <port>', 'Dashboard port', parseInt)
  .action(async (options) => {
    setLogLevel(options.logLevel);

    const envConfig = buildConfigFromEnv();
    if (options.address) {
      envConfig.hyperliquid.targetAddress = options.address;
    }

    if (!envConfig.hyperliquid.targetAddress) {
      console.error('Error: HYPERLIQUID_TARGET_ADDRESS is required. Set it in .env or pass --address');
      process.exit(1);
    }

    if (!envConfig.binance.apiKey || !envConfig.binance.apiSecret) {
      console.error('Error: BINANCE_API_KEY and BINANCE_API_SECRET are required.');
      process.exit(1);
    }

    const engine = new MirrorEngine(envConfig);
    let dashboard: DashboardServer | undefined;

    const gracefulShutdown = async () => {
      console.log('\nShutting down gracefully...');
      if (dashboard) await dashboard.stop();
      await engine.stop();
      process.exit(0);
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);

    if (options.dashboard ?? !!process.env.DASHBOARD_PORT) {
      const dashPort = options.dashboardPort ?? parseInt(process.env.DASHBOARD_PORT || '3001', 10);
      dashboard = new DashboardServer(dashPort, envConfig);
      dashboard.setEngine(engine);
      await dashboard.start();
    }

    try {
      await engine.start({
        ratio: options.ratio,
        marginType: options.marginType,
        priceTolerance: options.priceTolerance,
        dryRun: options.dryRun,
      });
      console.log('Mirror engine running. Press Ctrl+C to stop.');
    } catch (error) {
      console.error('Fatal error:', error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check connection status to Hyperliquid and Binance')
  .option('-l, --log-level <level>', 'Log level', 'INFO')
  .action(async (options) => {
    setLogLevel(options.logLevel);
    const config = buildConfigFromEnv();

    const { HyperliquidClient } = await import('./services/hyperliquid-client');
    const { BinanceService } = await import('./services/binance-service');

    console.log('Checking connections...\n');

    try {
      const hlClient = new HyperliquidClient(config.hyperliquid.apiUrl);
      if (config.hyperliquid.targetAddress) {
        const state = await hlClient.getClearinghouseState(config.hyperliquid.targetAddress);
        const positions = state.assetPositions.filter((ap) => parseFloat(ap.position.szi) !== 0);
        console.log(`✓ Hyperliquid connected. ${positions.length} active position(s) for ${config.hyperliquid.targetAddress}`);
        for (const ap of positions) {
          console.log(`  ${ap.position.coin}: ${ap.position.szi} @ ${ap.position.entryPx} (${ap.position.leverage.value}x ${ap.position.leverage.type})`);
        }
      } else {
        console.log('✗ HYPERLIQUID_TARGET_ADDRESS not configured');
      }
    } catch (error) {
      console.log(`✗ Hyperliquid connection failed: ${(error as Error).message}`);
    }

    try {
      const binance = new BinanceService(config.binance.apiKey, config.binance.apiSecret, config.binance.testnet);
      await binance.syncServerTime();
      const account = await binance.getAccountInfo();
      console.log(`✓ Binance connected. Balance: ${account.availableBalance} USDT (testnet: ${config.binance.testnet})`);
    } catch (error) {
      console.log(`✗ Binance connection failed: ${(error as Error).message}`);
    }
  });

program
  .command('positions <address>')
  .description('Show current positions for a Hyperliquid address')
  .option('-l, --log-level <level>', 'Log level', 'INFO')
  .action(async (address: string, options) => {
    setLogLevel(options.logLevel);
    const config = buildConfigFromEnv();
    const { HyperliquidClient } = await import('./services/hyperliquid-client');
    const { parseHlPosition } = await import('./types');

    const hlClient = new HyperliquidClient(config.hyperliquid.apiUrl);
    try {
      const state = await hlClient.getClearinghouseState(address);
      console.log(`\nAccount value: ${state.marginSummary.accountValue} USDT`);
      console.log(`Total margin used: ${state.marginSummary.totalMarginUsed} USDT`);
      console.log(`Withdrawable: ${state.withdrawable} USDT\n`);

      const activePositions = state.assetPositions.filter((ap) => parseFloat(ap.position.szi) !== 0);
      if (activePositions.length === 0) {
        console.log('No active positions.');
        return;
      }

      console.log('Active positions:');
      for (const ap of activePositions) {
        const mirrorPos = parseHlPosition(ap);
        if (mirrorPos) {
          console.log(
            `  ${ap.position.coin} (${mirrorPos.symbol}): ${mirrorPos.side} ${mirrorPos.size} @ ${mirrorPos.entryPrice}\n` +
            `    Leverage: ${mirrorPos.leverage}x ${mirrorPos.marginType} | PnL: ${mirrorPos.unrealizedPnl} | Liq: ${mirrorPos.liquidationPrice ?? 'N/A'}`,
          );
        }
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
    }
  });

program.parse();