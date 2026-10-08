/**
 * Minimal push-based queue that bridges event-emitter-style producers (e.g.
 * mssql's `Request` row/done/error events) into the Database Provider
 * Interface's `AsyncIterable<ResultChunk>` contract. Scoped to this one
 * bridging need, not a general-purpose utility.
 */
export class AsyncQueue<T> {
  private readonly buffer: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false
  private error: unknown

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
    } else {
      this.buffer.push(value)
    }
  }

  /** Signals no more values will be pushed; any pending `next()` resolves done. */
  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as unknown as T, done: true })
    }
  }

  /** Closes the queue in a failed state; the failure surfaces from the async iterator. */
  fail(err: unknown): void {
    this.error = err
    this.close()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!
        continue
      }
      if (this.closed) {
        if (this.error) throw this.error
        return
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      if (result.done) {
        if (this.error) throw this.error
        return
      }
      yield result.value
    }
  }
}
