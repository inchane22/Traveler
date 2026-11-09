// Which spend store a CLI uses: the ledger on disk for real calls, a copy in memory for recorded
// responses (fixtures cost nothing, so they never write a ledger line).
import { ledgerUsageStore, memoryUsageStore, type UsageStore } from "./budget.ts";
import { ledgerPath, monthsOf, readLedger } from "./ledger.ts";

export function usageStoreFor(root: string, offline: boolean): UsageStore {
  const path = ledgerPath(root);
  return offline ? memoryUsageStore(monthsOf(readLedger(path))) : ledgerUsageStore(path);
}
