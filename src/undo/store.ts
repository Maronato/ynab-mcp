import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { PendingOperation, UndoEntry, UndoHistoryFile } from "./types.js";

const DEFAULT_HISTORY: UndoHistoryFile = {
  entries: [],
  id_mappings: {},
};

/**
 * Pending-operation markers describe an interrupted (or ambiguous) write.
 * They exist precisely because nobody has reconciled the outcome yet, so
 * the expiry errs long — a week, not a day, since an unattended marker can
 * easily span a weekend — after which they expire on read and are dropped
 * from the file on the next persisted write.
 */
const PENDING_OPERATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Leftover atomic-write temp files older than this are deleted; younger
 * ones might belong to a live writer (possibly another process). */
const TMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;

/** Quarantined corrupt history files are kept a while for debugging. */
const CORRUPT_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface ListHistoryOptions {
  limit: number;
  offset?: number;
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

  private housekeepingStarted = false;

  // The history file is reparsed and rewritten whole on every write
  // operation (up to three times per tool call, counting pending markers),
  // so the cap is bounded by serialization latency rather than memory:
  // ~1 KB per compact entry keeps a full 2000-entry file around 2 MB.
  constructor(dataDirectory: string, maxEntriesPerBudget = 2000) {
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
  ): Promise<{ entries: UndoEntry[]; total: number }> {
    const history = await this.readBudgetHistory(budgetId);
    const filtered = history.entries.filter((entry) => {
      if (!options.includeUndone && entry.status !== "active") {
        return false;
      }

      return true;
    });

    const offset = options.offset ?? 0;
    return {
      entries: filtered.slice(offset, offset + options.limit),
      total: filtered.length,
    };
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
    // The random suffix keeps same-millisecond markers distinct, so
    // clearing one cannot delete another.
    const id = `${budgetId}::pending::${Date.now()}::${randomUUID().slice(0, 8)}`;
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

  async annotatePending(
    budgetId: string,
    pendingId: string,
    note: string,
  ): Promise<void> {
    await this.withBudgetLock(budgetId, async () => {
      const history = await this.readBudgetHistoryUnsafe(budgetId);
      const operation = (history.pending_operations ?? []).find(
        (op) => op.id === pendingId,
      );
      if (!operation) return;
      operation.note = note;
      await this.writeBudgetHistoryUnsafe(budgetId, history);
    });
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
        pending_operations: (Array.isArray(parsed.pending_operations)
          ? parsed.pending_operations
          : []
        ).filter((op) => !this.isExpiredPendingOperation(op)),
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
    // Compact JSON: this file is machine-read only, and it is rewritten on
    // every write operation, so pretty-printing would double the I/O.
    const content = JSON.stringify(history);

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

  private isExpiredPendingOperation(op: PendingOperation): boolean {
    const timestamp = Date.parse(op.timestamp);
    // An unparseable timestamp is kept, not silently dropped: the marker
    // is a warning about an unreconciled write, and losing it is worse
    // than showing a malformed one.
    if (!Number.isFinite(timestamp)) return false;
    return Date.now() - timestamp > PENDING_OPERATION_MAX_AGE_MS;
  }

  private async ensureHistoryDirectory(): Promise<void> {
    await mkdir(this.historyDirectory, { recursive: true });
    if (!this.housekeepingStarted) {
      this.housekeepingStarted = true;
      // Best-effort, off the hot path: stale artifacts are only ever noise.
      void this.cleanupStaleArtifacts().catch(() => {});
    }
  }

  /**
   * Delete leftover `.tmp` files (from atomic writes that never renamed)
   * and aged-out `.corrupt-*` quarantine files. Age thresholds keep live
   * writers' temp files and recent corruption evidence intact.
   */
  private async cleanupStaleArtifacts(): Promise<void> {
    const names = await readdir(this.historyDirectory);
    const now = Date.now();

    await Promise.all(
      names.map(async (name) => {
        const isTmp = name.endsWith(".tmp");
        const isCorrupt = name.includes(".corrupt-");
        if (!isTmp && !isCorrupt) return;

        const maxAge = isTmp ? TMP_FILE_MAX_AGE_MS : CORRUPT_FILE_MAX_AGE_MS;
        const filePath = join(this.historyDirectory, name);
        try {
          const info = await stat(filePath);
          if (now - info.mtimeMs > maxAge) {
            await unlink(filePath);
          }
        } catch {
          // Raced with another cleaner or writer; nothing to do.
        }
      }),
    );
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

  /**
   * Serialize read-modify-write cycles per budget WITHIN THIS PROCESS.
   *
   * The lock is deliberately in-process only. Two server processes sharing
   * the same data directory cannot corrupt a history file (writes go
   * through an atomic temp-file rename), but they can lose each other's
   * updates: both read, both modify, last rename wins. Advisory file locks
   * were considered and rejected — they hang on some network filesystems,
   * need stale-lock recovery after crashes, and the multi-process case
   * (several MCP servers pointed at one YNAB_MCP_DATA_DIR) is explicitly
   * unsupported. Run one server per data directory instead.
   */
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
