import fs from 'fs';
import path from 'path';
import { LibraryDatabase } from './db';
import { atomicMoveFile, cleanEmptyDirectories } from './categorizer';
import { computeFileSha256 } from './scanner';

export interface UndoResult {
  batchId: string;
  restoredCount: number;
  details: Array<{ from: string; to: string }>;
}

/**
 * Reverses a batch of file relocations from the atomic `undo_log` journal
 * and restores the original physical file paths in the SQLite index.
 */
export function undoLastBatch(db: LibraryDatabase, targetBatchId?: string): UndoResult | null {
  const batches = db.getUndoBatches();
  const pendingBatch = targetBatchId
    ? batches.find((b) => b.batch_id === targetBatchId && b.reverted === 0)
    : batches.find((b) => b.reverted === 0);

  if (!pendingBatch) {
    return null;
  }

  const details: Array<{ from: string; to: string }> = [];
  const touchedNewDirs = new Set<string>();

  for (const entry of pendingBatch.entries) {
    if (fs.existsSync(entry.new_path)) {
      const sha = computeFileSha256(entry.new_path);
      const restoredPath = atomicMoveFile(entry.new_path, entry.old_path, sha);
      db.updateFilePath(entry.file_id, restoredPath);
      details.push({ from: entry.new_path, to: restoredPath });
      touchedNewDirs.add(path.dirname(entry.new_path));
    }
  }

  db.markBatchReverted(pendingBatch.batch_id);

  // Clean up empty destination folders created by the reverted batch
  for (const dir of touchedNewDirs) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        const parent = path.dirname(dir);
        if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
          fs.rmdirSync(parent);
        }
      }
    } catch {
      // Ignore
    }
  }

  return {
    batchId: pendingBatch.batch_id,
    restoredCount: details.length,
    details,
  };
}
