import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { UndoEntry, UndoHistoryFile, UndoSessionScope } from "./types.js";

const DEFAULT_HISTORY: UndoHistoryFile = {
  entries: [],
  id_mappings: {},
};
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

interface ListHistoryOptions {
  sessionScope: UndoSessionScope;
  sessionId: string;
  limit: number;
  includeUndone: boolean;
}

export class UndoStore {
  private readonly historyDirectory: string;

  private readonly maxEntriesPerBudget: number;

  private readonly budgetLocks = new Map<string, Promise<void>>();

  constructor(dataDirectory: string, maxEntriesPerBudget = 200) {
    this.historyDirectory = join(dataDirectory, "history");
    this.maxEntriesPerBudget = maxEntriesPerBudget;
  }

  async appendEntries(budgetId: string, entries: UndoEntry[]): Promise<void> {
    await this.withBudgetLock(budgetId, async () => {
      const current = await this.readBudgetHistoryUnsafe(budgetId);
      current.entries = [...entries, ...current.entries].slice(
        0,
        this.maxEntriesPerBudget,
      );
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

      if (options.sessionScope === "all") {
        return true;
      }

      return entry.session_id === options.sessionId;
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
      history.id_mappings[sourceEntityId] = targetEntityId;

      for (const [key, value] of Object.entries(history.id_mappings)) {
        if (value === sourceEntityId) {
          history.id_mappings[key] = targetEntityId;
        }
      }

      for (const key of Object.keys(history.id_mappings)) {
        history.id_mappings[key] = this.resolveMappedIdFromHistory(
          history,
          key,
        );
      }

      await this.writeBudgetHistoryUnsafe(budgetId, history);
    });
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

  private getBudgetLockPath(budgetId: string): string {
    return join(this.historyDirectory, `${encodeURIComponent(budgetId)}.lock`);
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

  private async acquireBudgetFileLock(
    budgetId: string,
  ): Promise<() => Promise<void>> {
    await this.ensureHistoryDirectory();
    const lockPath = this.getBudgetLockPath(budgetId);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
      try {
        await mkdir(lockPath);
        return async () => {
          await rm(lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "EEXIST") {
          throw error;
        }

        if (await this.isBudgetLockStale(lockPath)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }

        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for undo history lock for budget "${budgetId}".`,
          );
        }

        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  private async isBudgetLockStale(lockPath: string): Promise<boolean> {
    try {
      const lockStats = await stat(lockPath);
      return Date.now() - lockStats.mtimeMs > LOCK_STALE_MS;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }

      throw error;
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
    let releaseFileLock: (() => Promise<void>) | undefined;

    try {
      // Combine a per-process queue with an on-disk lock so separate MCP
      // server processes do not race on the same history file.
      releaseFileLock = await this.acquireBudgetFileLock(budgetId);
      return await callback();
    } finally {
      await releaseFileLock?.();
      releaseLock?.();
      if (this.budgetLocks.get(budgetId) === current) {
        this.budgetLocks.delete(budgetId);
      }
    }
  }
}
