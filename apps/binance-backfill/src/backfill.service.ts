import { HttpService } from '@nestjs/axios'
import { Injectable, Logger } from '@nestjs/common'
import { parse } from 'csv-parse/sync'
import * as JSZip from 'jszip'
import { firstValueFrom } from 'rxjs'
import { DatabaseService } from '@database'
import { CANDLE_BUILDER_RULES } from '@orderflow/constants'
import { IAggregatedTrade } from '@orderflow/dto/binanceData.dto'
import { IFootPrintClosedCandle } from '@orderflow/dto/orderflow.dto'
import { calculateCandlesNeeded } from '@orderflow/utils/candles'
import { calculateStartDate } from '@orderflow/utils/date'
import { OrderFlowAggregator } from '@orderflow/utils/orderFlowAggregator'
import { mergeFootPrintCandles } from '@orderflow/utils/orderFlowUtil'
import { CACHE_LIMIT, Exchange, INTERVALS, KlineIntervalMs, KlineIntervalTimes } from '@tsquant/exchangeapi/dist/lib/constants'

@Injectable()
export class BackfillService {
  private readonly baseUrl = 'https://data.binance.vision/data/futures/um/daily/aggTrades'
  private readonly exchange: Exchange = Exchange.BINANCE
  private readonly BASE_INTERVAL = INTERVALS.ONE_MINUTE
  private currTestTime: Date = new Date()
  private nextMinuteCandleClose: Date = new Date()

  protected symbols: string[] = process.env.SYMBOLS ? process.env.SYMBOLS.split(',') : ['BTCUSDT']
  private readonly BASE_SYMBOL = this.symbols.shift() as string

  private logger: Logger = new Logger(BackfillService.name)

  private aggregators: { [symbol: string]: OrderFlowAggregator } = {}
  private candles: { [key: string]: IFootPrintClosedCandle[] } = {
    [INTERVALS.ONE_MINUTE]: [],
    [INTERVALS.FIVE_MINUTES]: [],
    [INTERVALS.FIFTEEN_MINUTES]: [],
    [INTERVALS.THIRTY_MINUTES]: [],
    [INTERVALS.ONE_HOUR]: [],
    [INTERVALS.TWO_HOURS]: [],
    [INTERVALS.FOUR_HOURS]: [],
    [INTERVALS.SIX_HOURS]: [],
    [INTERVALS.TWELVE_HOURS]: [],
    [INTERVALS.ONE_DAY]: [],
    [INTERVALS.ONE_WEEK]: [],
    [INTERVALS.ONE_MONTH]: []
  }

  constructor(private readonly databaseService: DatabaseService, private readonly httpService: HttpService) {}

  async onModuleInit() {
    console.time(`Backfilling for ${this.BASE_SYMBOL} took`)
    this.logger.log('start backfilling')

    const maxRowsInMemory = CACHE_LIMIT
    const intervalSizeMs: number = KlineIntervalMs[INTERVALS.ONE_MINUTE]
    this.aggregators[this.BASE_SYMBOL] = new OrderFlowAggregator(Exchange.BINANCE, this.BASE_SYMBOL, INTERVALS.ONE_MINUTE, intervalSizeMs, {
      maxCacheInMemory: maxRowsInMemory
    })

    await this.downloadAndProcessCsvFiles()
    this.printDebug()
    await this.saveData()
    console.timeEnd(`Backfilling for ${this.BASE_SYMBOL} took`)
  }

  private printDebug(): void {
    Object.keys(this.candles).forEach((interval: INTERVALS) => {
      this.logger.log(`${interval} has ${this.candles[interval].length} candles`)
      this.logger.log(`${interval} first open candle ${this.candles[interval]?.[0]?.openTime}`)
      this.logger.log(`${interval} last open candle ${this.candles[interval]?.[this.candles[interval].length - 1]?.openTime}`)
    })
  }

  private async saveData(specificInterval?: string): Promise<void> {
    this.logger.log('saving data')
    console.time('Saving data completed')

    const intervalSavedUUIDs: { [key: string]: string[] } = {}

    const intervalsToProcess = specificInterval ? [specificInterval] : Object.keys(this.candles)

    for (const interval of intervalsToProcess) {
      const candles = this.candles[interval]
      if (candles && candles.length > 0) {
        this.logger.log(`Processing ${candles.length} candles for interval ${interval}`)

        // Save the candles for the current interval
        const savedUUIDs = await this.databaseService.batchSaveFootPrintCandles(candles)
        // Store the UUIDs of the saved candles
        intervalSavedUUIDs[interval] = savedUUIDs

        this.logger.log(`Successfully saved ${savedUUIDs.length} out of ${candles.length} candles for interval ${interval}`)

        // Clear all items for this interval after saving
        this.candles[interval] = []

        // TODO: Check whether the candles were saved. Handle ones that aren't saved
      }
    }
    console.timeEnd('Saving data completed')
  }

  private checkAndBuildLargerTimeframeCandles(baseInterval: INTERVALS, targetInterval: INTERVALS, value: IFootPrintClosedCandle) {
    const rules = CANDLE_BUILDER_RULES[baseInterval]
    const targetRule = rules?.find((rule) => rule.target === targetInterval) ?? rules?.[0]
    const openTime: Date = new Date(value.openTimeMs)
    const { amount, duration } = KlineIntervalTimes[baseInterval]

    if (!targetRule) {
      return
    }

    if (duration === 'minutes') {
      openTime.setMinutes(openTime.getMinutes() + amount, 0, 0)
    } else if (duration === 'h') {
      openTime.setHours(openTime.getHours() + amount, 0, 0)
    }

    if (targetRule?.condition(openTime)) {
      const numCandlesNeeded: number = calculateCandlesNeeded(KlineIntervalMs[baseInterval], KlineIntervalMs[targetRule.target])

      if (this.candles[baseInterval].length >= numCandlesNeeded) {
        const candles: IFootPrintClosedCandle[] = this.candles[baseInterval].slice(-numCandlesNeeded)
        const newCandle: IFootPrintClosedCandle = mergeFootPrintCandles(candles, targetRule.target)

        const nextBase: INTERVALS = targetRule.target
        const nextTarget: INTERVALS = targetRule.target

        this.candles[targetRule.target].push(newCandle)
        this.checkAndBuildLargerTimeframeCandles(nextBase, nextTarget, newCandle)
      }
    }
  }

  private async closeAndPrepareNextCandle(): Promise<void> {
    const closedCandle: IFootPrintClosedCandle | undefined = this.aggregators[this.BASE_SYMBOL].retireActiveCandle()

    this.aggregators[this.BASE_SYMBOL].clearCandleQueue() // Because we don't need a queue here in this backfiller

    if (closedCandle) {
      this.candles[this.BASE_INTERVAL].push(closedCandle)
    }

    this.checkAndBuildLargerTimeframeCandles(
      this.BASE_INTERVAL,
      INTERVALS.FIVE_MINUTES,
      this.candles[INTERVALS.ONE_MINUTE][this.candles[INTERVALS.ONE_MINUTE].length - 1]
    )

    this.incrementTestMinute()
    this.aggregators[this.BASE_SYMBOL].createNewCandle(this.exchange, this.BASE_SYMBOL, this.BASE_INTERVAL, KlineIntervalMs[INTERVALS.ONE_MINUTE])
  }

  private processTradeRow(trade: IAggregatedTrade): void {
    const isBuyerMaker: boolean = trade.is_buyer_maker === 'true'
    const quantity: number = Number(trade.quantity)
    const price: number = Number(trade.price)
    this.aggregators[this.BASE_SYMBOL].processNewTrades(isBuyerMaker, quantity, price)
  }

  private incrementTestMinute(): void {
    this.currTestTime = new Date(this.nextMinuteCandleClose)
    this.nextMinuteCandleClose = new Date(this.nextMinuteCandleClose.getTime() + 60 * 1000)
    this.aggregators[this.BASE_SYMBOL].setCurrMinute(this.currTestTime)
  }

  private async downloadAndProcessCsvFiles() {
    const backfillStartAt = calculateStartDate(process.env.BACKFILL_START_AT as string)
    const backfillEndAt = calculateStartDate(process.env.BACKFILL_END_AT as string)
    let currentTestDate = new Date(backfillStartAt)

    console.time(`Downloading and processing aggTrades ${backfillStartAt} - ${backfillEndAt}`)

    this.currTestTime = new Date(backfillStartAt)
    this.nextMinuteCandleClose = new Date(this.currTestTime.getTime() + 60000)
    this.aggregators[this.BASE_SYMBOL].setCurrMinute(this.currTestTime)

    this.logger.log(`backfillStartAt ${backfillStartAt}`)
    this.logger.log(`backfillEndAt: ${backfillEndAt}`)
    this.logger.log(`currTestTime: ${this.currTestTime}`)
    this.logger.log(`nextMinuteCandleClose: ${this.nextMinuteCandleClose}`)

    while (currentTestDate <= backfillEndAt) {
      const dateString = currentTestDate.toISOString().split('T')[0]
      const fileUrl = `${this.baseUrl}/${this.BASE_SYMBOL}/${this.BASE_SYMBOL}-aggTrades-${dateString}.zip`

      try {
        console.time(`downloading ${fileUrl}`)
        const response: any = await firstValueFrom(
          this.httpService.get(fileUrl, {
            responseType: 'arraybuffer'
          })
        )
        console.timeEnd(`downloading ${fileUrl}`)

        console.time(`extracting ${fileUrl}`)
        const zip = await JSZip.loadAsync(response.data)
        const csvFileName: string = Object.keys(zip.files)[0]
        const csvFile: string = await zip.files[csvFileName].async('string')
        console.timeEnd(`extracting ${fileUrl}`)

        console.time(`parsing ${fileUrl}`)
        const trades = parse(csvFile, {
          columns: true,
          skip_empty_lines: true
        })
        console.timeEnd(`parsing ${fileUrl}`)

        console.time('Processing trades')
        this.logger.log(`trades ${trades.length}`)
        for (let i = 0; i < trades.length; i++) {
          const trade: IAggregatedTrade = trades[i]
          const transactTimestamp: number = Number(trade.transact_time)
          const tradeTime = new Date(transactTimestamp)

          if (tradeTime >= this.nextMinuteCandleClose || i === trades.length - 1) {
            await this.closeAndPrepareNextCandle()
          }
          this.processTradeRow(trade)
        }
        console.timeEnd('Processing trades')

        this.logger.log(`Downloaded and parsed file for ${dateString}`)
        await this.saveData(INTERVALS.ONE_MINUTE) // Clear up memory by saving & removing the 1440 1m candles for this file
      } catch (error) {
        this.logger.error(`Failed to download or process the file for ${dateString}:`, error)
      }

      currentTestDate = new Date(currentTestDate.setDate(currentTestDate.getDate() + 1))
    }
    console.timeEnd(`Downloading and processing aggTrades ${backfillStartAt} - ${backfillEndAt}`)
  }
}
