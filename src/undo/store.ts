import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_SESSION_ID } from "../shared/session.js";
import type { UndoEntry, UndoHistoryFile } from "./types.js";

const DEFAULT_HISTORY: UndoHistoryFile = {
  entries: [],
  id_mappings: {},
};
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

interface ListHistoryOptions {
  sessionId: string;
  limit: number;
  includeUndone: boolean;
  includeAllSessions?: boolean;
}

interface UndoStoreOptions {
  sessionTtlMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

interface IdMappingUpdate {
  sourceEntityId: string;
  targetEntityId: string;
}

export class UndoStore {
  private readonly historyDirectory: string;

  private readonly maxEntriesPerBudget: number;

  private readonly sessionTtlMs: number;

  private readonly cleanupIntervalMs: number;

  private readonly now: () => number;

  private lastCleanupMs = 0;

  private readonly budgetLocks = new Map<string, Promise<void>>();

  constructor(
    dataDirectory: string,
    maxEntriesPerBudget = 200,
    options: UndoStoreOptions = {},
  ) {
    this.historyDirectory = join(dataDirectory, "history");
    this.maxEntriesPerBudget = maxEntriesPerBudget;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.cleanupIntervalMs =
      options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
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

      const currentTime = this.now();
      if (this.shouldRunCleanup(currentTime)) {
        this.purgeExpiredSessions(current, currentTime);
        this.lastCleanupMs = currentTime;
      }

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

      if (options.includeAllSessions) {
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
      this.applyIdMapping(history, sourceEntityId, targetEntityId);

      await this.writeBudgetHistoryUnsafe(budgetId, history);
    });
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

  private shouldRunCleanup(currentTime: number): boolean {
    return currentTime - this.lastCleanupMs >= this.cleanupIntervalMs;
  }

  private purgeExpiredSessions(
    history: UndoHistoryFile,
    currentTime: number,
  ): void {
    const expiryCutoff = currentTime - this.sessionTtlMs;
    const newestBySession = new Map<string, number>();

    for (const entry of history.entries) {
      if (entry.session_id === DEFAULT_SESSION_ID) {
        continue;
      }

      const timestamp = Date.parse(entry.timestamp);
      if (Number.isNaN(timestamp)) {
        continue;
      }

      const currentNewest = newestBySession.get(entry.session_id);
      if (currentNewest === undefined || timestamp > currentNewest) {
        newestBySession.set(entry.session_id, timestamp);
      }
    }

    const expiredSessions = new Set<string>();
    for (const [sessionId, newestTimestamp] of newestBySession.entries()) {
      if (newestTimestamp < expiryCutoff) {
        expiredSessions.add(sessionId);
      }
    }

    if (expiredSessions.size === 0) {
      return;
    }

    history.entries = history.entries.filter(
      (entry) => !expiredSessions.has(entry.session_id),
    );
    this.pruneIdMappings(history);
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
