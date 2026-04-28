import type { BusEvent } from "@aegis/sdk";

type Handler = (event: BusEvent) => void;

export class EventBus {
  private readonly handlers: Handler[] = [];

  subscribe(handler: Handler): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  emit(event: BusEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        console.error("[bus] handler threw", err);
      }
    }
  }
}
