import { DatabaseService } from '@database/database.service'
import { IFootPrintClosedCandle } from '@orderflow/dto/orderflow.dto'

export class CandleQueue {
  private maxCacheInMemory: number = 600

  /** Queue of candles that may not yet have reached the DB yet (closed candles) */
  private queue: IFootPrintClosedCandle[] = []

  private databaseService: DatabaseService

  private isProcessingJob: boolean = false

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService
  }

  /** Get only candles that haven't been saved to DB yet */
  public getQueuedCandles(): IFootPrintClosedCandle[] {
    return this.queue.filter((candle) => !candle.didPersistToStore)
  }

  public enqueCandle(candle: IFootPrintClosedCandle): void {
    this.queue.push(candle)
  }

  public clearQueue(): void {
    this.queue = []
  }

  /** Call to ensure candle queue is trimmed within max length (oldest are discarded first) */
  public pruneQueue() {
    const MAX_QUEUE_LENGTH = this.maxCacheInMemory
    if (this.queue.length <= MAX_QUEUE_LENGTH) {
      return
    }

    // Trim store to last x candles, based on config
    const rowsToTrim = this.queue.length - MAX_QUEUE_LENGTH

    console.log(`removing ${rowsToTrim} candles from aggregator queue. Length before: ${this.queue.length}`)
    this.queue.splice(0, rowsToTrim)
    console.log(`len after: ${this.queue.length}`)
  }

  /** Marks which candles have been saved to DB */
  public markSavedCandles(savedUUIDs: string[]) {
    // console.log(`markSavedCandles: ${savedUUIDs}`)
    for (const uuid of savedUUIDs) {
      const candle = this.queue.find((c) => c.uuid === uuid)
      if (candle) {
        candle.didPersistToStore = true
        // console.log(`successfully marked: ${uuid}`)
      } else {
        console.log(`no candle found for uuid (${uuid})`, this.queue)
      }
    }
  }

  private async persistCandlesToStorage() {
    const queuedCandles = this.getQueuedCandles()
    if (queuedCandles.length === 0) {
      return
    }

    console.log(
      'Saving batch of candles',
      queuedCandles.map((c) => c.uuid)
    )

    const savedUUIDs = await this.databaseService.batchSaveFootPrintCandles([...queuedCandles])

    // Filter out successfully saved candles
    this.markSavedCandles(savedUUIDs)
    this.pruneQueue()
  }
}
