import type { PayeeProfileAnalyzer } from "./analysis/payee-profiles.js";
import type { UndoEngine } from "./undo/engine.js";
import type { YnabClient } from "./ynab/client.js";

export interface AppContext {
  ynabClient: YnabClient;
  undoEngine: UndoEngine;
  payeeProfileAnalyzer: PayeeProfileAnalyzer;
}
