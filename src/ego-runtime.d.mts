import type { BridgeReceipt } from './ego-transport/index.ts';
export function execute(request: { operation: string; args: Record<string, unknown> }): Promise<BridgeReceipt>;
export function publicBrowserUrl(raw: string): string;
