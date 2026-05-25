import WebSocket from 'ws';
import { config } from '../config';
import { logger } from '../utils/logger';
import { diffSubscriptions, miniTickerStream } from './subscriptions';

/**
 * Live crypto prices via Binance's WebSocket `@miniTicker` stream (one update
 * per symbol roughly every second) instead of REST polling. A single raw-stream
 * connection is kept open; the subscribed symbol set is reconciled on the fly
 * with SUBSCRIBE/UNSUBSCRIBE control messages as positions open/close.
 */

type PriceHandler = (symbol: string, price: number) => void;

export class BinanceStream {
  private ws: WebSocket | null = null;
  private subscribed = new Set<string>(); // uppercase symbols currently on the wire
  private desired = new Set<string>(); // uppercase symbols we want
  private msgId = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closedByUs = false;

  constructor(private readonly onPrice: PriceHandler) {}

  /** Declare the exact set of crypto symbols to stream. Idempotent. */
  setSymbols(symbols: string[]): void {
    this.desired = new Set(symbols.map((s) => s.toUpperCase()));
    if (this.desired.size === 0) {
      // Nothing to stream — drop the connection to stay idle-clean.
      this.subscribed.clear();
      this.teardown();
      return;
    }
    if (!this.ws) {
      this.connect();
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) this.reconcile();
  }

  private connect(): void {
    this.closedByUs = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(config.BINANCE_WS_BASE);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Binance WS construct failed');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.subscribed.clear(); // fresh socket has no subscriptions
      logger.info('Binance WS connected');
      this.reconcile();
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        // miniTicker payload: { e:'24hrMiniTicker', s:'BTCUSDT', c:'67000.00', ... }
        if (msg && msg.e === '24hrMiniTicker' && typeof msg.s === 'string') {
          const price = parseFloat(msg.c);
          if (Number.isFinite(price)) this.onPrice(msg.s, price);
        }
        // SUBSCRIBE/UNSUBSCRIBE acks look like { result:null, id:N } — ignored.
      } catch {
        /* non-JSON / control frame — ignore */
      }
    });

    ws.on('close', () => {
      if (!this.closedByUs) {
        logger.warn('Binance WS closed — reconnecting');
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      logger.warn({ err: err.message }, 'Binance WS error');
      // 'close' will follow and trigger the reconnect.
    });
  }

  /** Bring the wire's subscriptions in line with `desired`. */
  private reconcile(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const { add, remove } = diffSubscriptions(this.subscribed, this.desired);
    if (add.length) {
      this.send('SUBSCRIBE', add);
      add.forEach((s) => this.subscribed.add(s));
    }
    if (remove.length) {
      this.send('UNSUBSCRIBE', remove);
      remove.forEach((s) => this.subscribed.delete(s));
    }
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', symbols: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({ method, params: symbols.map(miniTickerStream), id: ++this.msgId })
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.desired.size === 0) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.closedByUs = true;
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
  }

  stop(): void {
    this.teardown();
  }
}
