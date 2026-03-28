import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PendingOperation, UndoEntry, UndoHistoryFile } from "./types.js";

const DEFAULT_HISTORY: UndoHistoryFile = {
  entries: [],
  id_mappings: {},
};

interface ListHistoryOptions {
  limit: number;
  includeUndone: boolean;
}

interface IdMappingUpdate {
  sourceEntityId: string;
  targetEntityId: string;
}

export class UndoStore {
  private readonly historyDirectory: string;

  private readonly maxEntriesPerBudget: number;

  private readonly budgetLocks = new Map<string, Promise<void>>();

  constructor(dataDirectory: string, maxEntriesPerBudget = 200) {
    this.historyDirectory = join(dataDirectory, "history");
    this.maxEntriesPerBudget = maxEntriesPerBudget;
  }

  async appendEntries(
    budgetId: string,
    entries: UndoEntry[],
    idMappings: IdMappingUpdate[] = [],
  ): Promise<void> {
    if (entries.length === 0 && idMappings.length === 0) {
      return;
    }

    await this.withBudgetLock(budgetId, async () => {
      const current = await this.readBudgetHistoryUnsafe(budgetId);
      current.entries = [...entries, ...current.entries].slice(
        0,
        this.maxEntriesPerBudget,
      );

      for (const { sourceEntityId, targetEntityId } of idMappings) {
        this.applyIdMapping(current, sourceEntityId, targetEntityId);
      }
      this.pruneIdMappings(current);

      await this.writeBudgetHistoryUnsafe(budgetId, current);
    });
  }

  async listEntries(
    budgetId: string,
    options: ListHistoryOptions,
  ): Promise<UndoEntry[]> {
    const history = await this.readBudgetHistory(budgetId);
    const filtered = history.entries.filter((entry) => {
      if (!options.includeUndone && entry.status !== "active") {
        return false;
      }

      return true;
    });

    return filtered.slice(0, options.limit);
  }

  async getEntriesByIds(
    budgetId: string,
    entryIds: string[],
  ): Promise<Array<UndoEntry | undefined>> {
    const history = await this.readBudgetHistory(budgetId);
    const index = new Map(history.entries.map((entry) => [entry.id, entry]));

    return entryIds.map((entryId) => index.get(entryId));
  }

  async markEntriesUndone(budgetId: string, entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) {
      return;
    }

    await this.withBudgetLock(budgetId, async () => {
      const history = await this.readBudgetHistoryUnsafe(budgetId);
      const entryIdSet = new Set(entryIds);

      history.entries = history.entries.map((entry) => {
        if (entryIdSet.has(entry.id)) {
          return {
            ...entry,
            status: "undone",
          };
        }

        return entry;
      });

      await this.writeBudgetHistoryUnsafe(budgetId, history);
    });
  }

  async resolveMappedId(budgetId: string, entityId: string): Promise<string> {
    const history = await this.readBudgetHistory(budgetId);
    return this.resolveMappedIdFromHistory(history, entityId);
  }

  async updateIdMappings(
    budgetId: string,
    sourceEntityId: string,
    targetEntityId: string,
  ): Promise<void> {
    await this.withBudgetLock(budgetId, async () => {
      const history = await this.readBudgetHistoryUnsafe(budgetId);
      this.applyIdMapping(history, sourceEntityId, targetEntityId);

      await this.writeBudgetHistoryUnsafe(budgetId, history);
    });
  }

  async markPending(budgetId: string, description: string): Promise<string> {
    const id = `${budgetId}::pending::${Date.now()}`;
    const op: PendingOperation = {
      id,
      budget_id: budgetId,
      timestamp: new Date().toISOString(),
      description,
    };

    await this.withBudgetLock(budgetId, async () => {
      const history = await this.readBudgetHistoryUnsafe(budgetId);
      const pending = history.pending_operations ?? [];
      pending.push(op);
      history.pending_operations = pending;
      await this.writeBudgetHistoryUnsafe(budgetId, history);
    });

    return id;
  }

  async clearPending(budgetId: string, pendingId: string): Promise<void> {
    await this.withBudgetLock(budgetId, async () => {
      const history = await this.readBudgetHistoryUnsafe(budgetId);
      history.pending_operations = (history.pending_operations ?? []).filter(
        (op) => op.id !== pendingId,
      );
      await this.writeBudgetHistoryUnsafe(budgetId, history);
    });
  }

  async getPendingOperations(budgetId: string): Promise<PendingOperation[]> {
    const history = await this.readBudgetHistory(budgetId);
    return history.pending_operations ?? [];
  }

  private applyIdMapping(
    history: UndoHistoryFile,
    sourceEntityId: string,
    targetEntityId: string,
  ): void {
    history.id_mappings[sourceEntityId] = targetEntityId;

    for (const [key, value] of Object.entries(history.id_mappings)) {
      if (value === sourceEntityId) {
        history.id_mappings[key] = targetEntityId;
      }
    }

    for (const key of Object.keys(history.id_mappings)) {
      history.id_mappings[key] = this.resolveMappedIdFromHistory(history, key);
    }
  }

  private resolveMappedIdFromHistory(
    history: UndoHistoryFile,
    entityId: string,
  ): string {
    const visited = new Set<string>();
    let current = entityId;

    while (history.id_mappings[current] && !visited.has(current)) {
      visited.add(current);
      current = history.id_mappings[current];
    }

    return current;
  }

  private async readBudgetHistory(budgetId: string): Promise<UndoHistoryFile> {
    return this.withBudgetLock(budgetId, async () =>
      this.readBudgetHistoryUnsafe(budgetId),
    );
  }

  private async readBudgetHistoryUnsafe(
    budgetId: string,
  ): Promise<UndoHistoryFile> {
    await this.ensureHistoryDirectory();
    const filePath = this.getBudgetHistoryPath(budgetId);

    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as Partial<UndoHistoryFile>;

      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        id_mappings:
          parsed.id_mappings && typeof parsed.id_mappings === "object"
            ? parsed.id_mappings
            : {},
        pending_operations: Array.isArray(parsed.pending_operations)
          ? parsed.pending_operations
          : [],
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return { ...DEFAULT_HISTORY };
      }

      if (error instanceof SyntaxError) {
        await this.quarantineCorruptHistoryFile(filePath);
        return { ...DEFAULT_HISTORY };
      }

      throw error;
    }
  }

  private async writeBudgetHistoryUnsafe(
    budgetId: string,
    history: UndoHistoryFile,
  ): Promise<void> {
    await this.ensureHistoryDirectory();
    const filePath = this.getBudgetHistoryPath(budgetId);
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const content = JSON.stringify(history, null, 2);

    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  }

  private pruneIdMappings(history: UndoHistoryFile): void {
    const referencedIds = new Set<string>();
    for (const entry of history.entries) {
      referencedIds.add(entry.undo_action.entity_id);
    }

    for (const key of Object.keys(history.id_mappings)) {
      const resolved = this.resolveMappedIdFromHistory(history, key);
      if (!referencedIds.has(key) && !referencedIds.has(resolved)) {
        delete history.id_mappings[key];
      }
    }
  }

  private async ensureHistoryDirectory(): Promise<void> {
    await mkdir(this.historyDirectory, { recursive: true });
  }

  private getBudgetHistoryPath(budgetId: string): string {
    return join(this.historyDirectory, `${encodeURIComponent(budgetId)}.json`);
  }

  private async quarantineCorruptHistoryFile(filePath: string): Promise<void> {
    const corruptPath = `${filePath}.corrupt-${process.pid}-${Date.now()}`;

    try {
      await rename(filePath, corruptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async withBudgetLock<T>(
    budgetId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous = this.budgetLocks.get(budgetId) ?? Promise.resolve();
    let releaseLock: (() => void) | undefined;

    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.budgetLocks.set(
      budgetId,
      previous.then(() => current),
    );

    await previous;

    try {
      return await callback();
    } finally {
      releaseLock?.();
      if (this.budgetLocks.get(budgetId) === current) {
        this.budgetLocks.delete(budgetId);
      }
    }
  }
}
