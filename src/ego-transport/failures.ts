/** Adapted from cortico-world-ego (MIT, Copyright (c) 2026 筆離嘢); see LICENSE. */
import type { BridgeReceipt } from './types.ts';

export function normalizeFailure(receipt: BridgeReceipt): BridgeReceipt {
  if (receipt.code) return receipt;
  const error = receipt.error ?? '';
  if (/ego lite closed the connection because ego-browser is running as administrator/i.test(error)) return { ...receipt, code: 'EGO_CLIENT_ELEVATED', uncertain: false };
  if (/\bENOENT\b/.test(error) && !receipt.uncertain) return { ...receipt, code: 'EGO_CLI_NOT_FOUND', uncertain: false };
  if (/Failed to connect to ego_cli bootstrap/i.test(error)) return { ...receipt, code: 'EGO_BROWSER_UNAVAILABLE', uncertain: false };
  if (!receipt.uncertain && /^task space not found:\s*\d+\s*$/i.test(error)) return { ...receipt, code: 'EGO_TASK_SPACE_NOT_FOUND' };
  return receipt;
}
export function isConnectionFailure(code?: string): boolean {
  return ['EGO_CLIENT_ELEVATED', 'EGO_CLI_NOT_FOUND', 'EGO_BROWSER_UNAVAILABLE', 'EGO_HELPER_UNAVAILABLE', 'EGO_HELPER_REQUIRED', 'EGO_HELPER_VERSION'].includes(code ?? '');
}
