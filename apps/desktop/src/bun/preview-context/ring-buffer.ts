export class RingBuffer<T> {
  private buf: T[];
  private head = 0;
  private len = 0;
  private dropCount = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array<T>(capacity);
  }

  push(item: T): void {
    if (this.len >= this.capacity) {
      // Overwrite oldest slot.
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      this.dropCount++;
    } else {
      this.buf[(this.head + this.len) % this.capacity] = item;
      this.len++;
    }
  }

  items(): readonly T[] {
    if (this.len === 0) return [];
    const result: T[] = [];
    for (let i = 0; i < this.len; i++) {
      const item = this.buf[(this.head + i) % this.capacity];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  get droppedCount(): number {
    return this.dropCount;
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
    this.dropCount = 0;
  }
}
