/** Adapted from cortico-world-ego (MIT, Copyright (c) 2026 筆離嘢); see LICENSE. */
export interface EvaluationTimeout {
  page?: string; timeoutMs?: number; executionStopped?: boolean; pageResponsive?: boolean; mayHaveLateEffects?: boolean;
}
export interface BridgeReceipt {
  spaceId?: number;
  value?: any;
  error?: string;
  code?: string;
  uncertain?: boolean;
  evaluation?: EvaluationTimeout;
  source?: { url: string; title: string; snippet: string };
}
export interface EgoBridge {
  run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt>;
}
export const MAX_RECEIPT_BYTES = 12 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 128 * 1024;
export function validReceipt(value: unknown): value is BridgeReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as BridgeReceipt;
  return (Object.hasOwn(item, 'value') || typeof item.error === 'string')
    && (item.spaceId === undefined || Number.isSafeInteger(item.spaceId) && item.spaceId > 0)
    && (item.code === undefined || typeof item.code === 'string')
    && (item.uncertain === undefined || typeof item.uncertain === 'boolean')
    && (item.source === undefined || item.source !== null && typeof item.source === 'object'
      && typeof item.source.url === 'string' && typeof item.source.title === 'string' && typeof item.source.snippet === 'string');
}
