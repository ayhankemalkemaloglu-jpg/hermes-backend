import { config } from '../config';
import * as binance from './binance';
import * as yahoo from './yahoo';
import { classifyMarket, type Market } from './marketClassifier';
import type { Candle } from './binance';

/**
 * Single entry point for prices/candles. Crypto pairs route to Binance, BIST
 * equities route to Yahoo Finance. Callers (trade close, live poller, charts)
 * stay source-agnostic.
 */

export type { Candle, Market };

/** Classify a symbol using the configured BIST allowlist as an override. */
export function resolveMarket(symbol: string): Market {
  return classifyMarket(symbol, config.bistSymbols);
}

export async function getCurrentPrice(symbol: string): Promise<number | null> {
  return resolveMarket(symbol) === 'BIST'
    ? yahoo.getYahooPrice(symbol)
    : binance.getCurrentPrice(symbol);
}

export async function getKlines(
  symbol: string,
  timeframe: string,
  limit: number
): Promise<Candle[] | null> {
  return resolveMarket(symbol) === 'BIST'
    ? yahoo.getYahooKlines(symbol, timeframe, limit)
    : binance.getKlines(symbol, timeframe, limit);
}
