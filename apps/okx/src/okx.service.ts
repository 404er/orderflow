import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Instrument, RestClient, Trade } from 'okx-api';
import { DatabaseService } from '@database';
import { RabbitMQService } from '@rabbitmq';
import { OkxWebSocketService } from './okx.websocket.service';
import { IFootPrintClosedCandle } from '@orderflow/dto/orderflow.dto';
import { CandleQueue } from '@orderflow/utils/candleQueue';
import { OrderFlowAggregator } from '@orderflow/utils/orderFlowAggregator';
import { INTERVALS, KlineIntervalMs } from '@shared/utils/intervals';
import { aggregationIntervalMap } from '@orderflow/constants/aggregation';
import { findAllEffectedHTFIntervalsOnCandleClose } from '@orderflow/utils/candleBuildHelper';
import { mergeFootPrintCandles } from '@orderflow/utils/orderFlowUtil';
import { Exchange } from '@shared/constants/exchange';
import { normaliseSymbolName } from 'apps/okx/src/okx.utils';

@Injectable()
export class OkxService {
  private logger: Logger = new Logger(OkxService.name);
  private selectedSymbols: string[] = process.env.SYMBOLS?.split(',') ?? [];
  private readonly BASE_INTERVAL = INTERVALS.ONE_MINUTE;
  private readonly HTF_INTERVALS = [
    INTERVALS.FIVE_MINUTES,
    INTERVALS.FIFTEEN_MINUTES,
    INTERVALS.THIRTY_MINUTES,
    INTERVALS.ONE_HOUR,
    INTERVALS.TWO_HOURS,
    INTERVALS.FOUR_HOURS,
    INTERVALS.EIGHT_HOURS,
    INTERVALS.TWELVE_HOURS,
    INTERVALS.ONE_DAY,
    INTERVALS.ONE_WEEK,
    INTERVALS.ONE_MONTH
  ];

  private didFinishConnectingWS: boolean = false;

  private okxRest = new RestClient();

  private aggregators: { [symbol: string]: OrderFlowAggregator } = {};
  private candleQueue: CandleQueue;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly okxWsService: OkxWebSocketService,
    private readonly rabbitmqService: RabbitMQService
  ) {
    this.candleQueue = new CandleQueue(Exchange.OKX, this.databaseService, this.rabbitmqService);
  }

  async onModuleInit() {
    this.logger.log(`Starting Okx Orderflow service for Live candle building`);
    await this.subscribeToWS();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handlePrune() {
    await this.databaseService.pruneOldData();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processMinuteCandleClose() {
    if (!this.didFinishConnectingWS) {
      return;
    }

    const closed1mCandles: { [symbol: string]: IFootPrintClosedCandle } = {};
    const triggeredIntervalsPerSymbol: { [symbol: string]: INTERVALS[] } = {};

    // Process 1m candles and determine triggered intervals
    for (const symbol in this.aggregators) {
      const aggr = this.getOrderFlowAggregator(symbol, this.BASE_INTERVAL);
      const closed1mCandle = aggr.processCandleClosed();

      if (closed1mCandle) {
        this.candleQueue.enqueCandle(closed1mCandle);
        closed1mCandles[symbol] = closed1mCandle;

        const nextOpenTimeMS = 1 + closed1mCandle.closeTimeMs;
        const nextOpenTime = new Date(nextOpenTimeMS);
        triggeredIntervalsPerSymbol[symbol] = findAllEffectedHTFIntervalsOnCandleClose(nextOpenTime, this.HTF_INTERVALS);
      }
    }

    // Persist 1m candles
    await this.candleQueue.persistCandlesToStorage({ clearQueue: true });

    // Process HTF candles
    for (const interval of this.HTF_INTERVALS) {
      for (const symbol in closed1mCandles) {
        if (triggeredIntervalsPerSymbol[symbol].includes(interval)) {
          const closed1mCandle = closed1mCandles[symbol];
          const htfCandle = await this.buildHTFCandle(symbol, interval, closed1mCandle.openTimeMs, closed1mCandle.closeTimeMs);
          if (htfCandle) {
            this.candleQueue.enqueCandle(htfCandle);
          }
        }
      }
      await this.candleQueue.persistCandlesToStorage({ clearQueue: true });
    }
  }

  private async subscribeToWS(): Promise<void> {
    const instrumentInfo: Instrument[] = await this.okxRest.getInstruments('SWAP');
    const filteredInstruments: Instrument[] = instrumentInfo.filter((instrument: Instrument) => {
      const symbol = normaliseSymbolName(instrument.instId);
      return instrument['settleCcy'] === 'USDT' && (this.selectedSymbols.length > 0 ? this.selectedSymbols.includes(symbol) : true);
    });
    const symbols = filteredInstruments.map((instrument) => instrument.instId);

    this.okxWsService.initWebSocket(instrumentInfo);

    await this.okxWsService.subscribeToTopics(symbols, 'linear');

    this.didFinishConnectingWS = true;

    this.okxWsService.tradeUpdates.subscribe((trades: Trade[]) => {
      for (let i = 0; i < trades.length; i++) {
        const isPassiveBid: boolean = trades[i].side === 'sell';
        this.processNewTrades(trades[i].instId, isPassiveBid, trades[i].sz, Number(trades[i].px));
      }
    });
  }

  private getOrderFlowAggregator(instrumentId: string, interval: string): OrderFlowAggregator {
    const symbol = normaliseSymbolName(instrumentId);
    if (!this.aggregators[symbol]) {
      const intervalSizeMs: number = KlineIntervalMs[interval];
      if (!intervalSizeMs) {
        throw new Error(`Unknown ms per interval "${interval}"`);
      }

      this.aggregators[symbol] = new OrderFlowAggregator(Exchange.OKX, symbol, interval, intervalSizeMs, {});
    }

    return this.aggregators[symbol];
  }

  async buildHTFCandle(symbol: string, targetInterval: INTERVALS, openTimeMs: number, closeTimeMs: number): Promise<IFootPrintClosedCandle | null> {
    const { baseInterval, count } = aggregationIntervalMap[targetInterval];

    this.logger.log(`Building a new HTF candle for ${symbol} ${targetInterval}. Will attempt to find and use ${count} ${baseInterval} candles`);

    const baseIntervalMs = KlineIntervalMs[baseInterval];
    const aggregationStart = closeTimeMs - baseIntervalMs * count;
    const aggregationEnd = closeTimeMs;

    const candles = await this.databaseService.getCandles(Exchange.OKX, symbol, baseInterval, aggregationStart, aggregationEnd);

    if (candles?.length === count) {
      const aggregatedCandle = mergeFootPrintCandles(candles, targetInterval);
      if (aggregatedCandle) {
        return aggregatedCandle;
      }
    } else {
      this.logger.warn(
        `Target candle count ${count} was not met to create a new candle for ${symbol}, ${targetInterval}. Candle closed at ${new Date(closeTimeMs)}`
      );
    }

    return null;
  }

  private processNewTrades(instrumentId: string, isPassiveBid: boolean, positionSize: string, price: number) {
    if (!this.didFinishConnectingWS) {
      return;
    }

    const aggr = this.getOrderFlowAggregator(instrumentId, this.BASE_INTERVAL);
    aggr.processNewTrades(isPassiveBid, Number(positionSize), price);
  }
}
