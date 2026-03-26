import { UndoEngine } from "./undo/engine.js";
import { YnabClient } from "./ynab/client.js";

export interface AppContext {
  ynabClient: YnabClient;
  undoEngine: UndoEngine;
}
