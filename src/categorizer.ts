import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { ExtractedBookMetadata, ScannedFileInfo } from './scanner';
import { LibraryDatabase } from './db';

export type TaxonomyMap = Record<string, Record<string, string[]>>;

export interface ParsedRule {
  raw: string;
  field: 'title' | 'author' | 'bookmarks' | 'text' | 'any';
  regex: RegExp;
  category: string;
  subcategory: string;
}

export interface CategorizationMatch {
  category: string;
  subcategory: string;
  confidence: 'rule' | 'taxonomy' | 'interactive' | 'fallback';
  matchedRuleOrKeyword?: string;
}

export interface PlannedFileMove {
  bookId: string;
  title: string;
  author: string | null;
  category: string;
  subcategory: string;
  format: string;
  sourcePath: string;
  destinationPath: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Loads `taxonomy.json` from the project root or returns default structure.
 */
export function loadTaxonomy(rootDir: string): TaxonomyMap {
  const taxonomyPath = path.join(rootDir, 'taxonomy.json');
  if (fs.existsSync(taxonomyPath)) {
    try {
      return JSON.parse(fs.readFileSync(taxonomyPath, 'utf8')) as TaxonomyMap;
    } catch {
      // Fallback
    }
  }
  return {
    Uncategorized: {
      General: [],
    },
  };
}

/**
 * Saves updated `taxonomy.json` when new categories are created.
 */
export function saveTaxonomy(rootDir: string, taxonomy: TaxonomyMap): void {
  const taxonomyPath = path.join(rootDir, 'taxonomy.json');
  fs.writeFileSync(taxonomyPath, JSON.stringify(taxonomy, null, 2), 'utf8');
}

/**
 * Parses `rules.json` regex rules such as:
 * `"title =~ /thermodynamics/i -> Physics/Thermodynamics"`
 */
export function loadRules(rootDir: string): ParsedRule[] {
  const rulesPath = path.join(rootDir, 'rules.json');
  if (!fs.existsSync(rulesPath)) return [];

  try {
    const rawJson = JSON.parse(fs.readFileSync(rulesPath, 'utf8')) as { rules?: string[] };
    const ruleStrings = Array.isArray(rawJson.rules) ? rawJson.rules : [];
    const parsed: ParsedRule[] = [];

    const ruleSyntax = /^(\w+)\s*=~\s*\/(.+)\/([gimsuy]*)\s*->\s*([^/]+)\/(.+)$/;
    for (const r of ruleStrings) {
      const m = r.trim().match(ruleSyntax);
      if (m) {
        const fieldRaw = m[1].toLowerCase();
        const field = (['title', 'author', 'bookmarks', 'text', 'any'].includes(fieldRaw)
          ? fieldRaw
          : 'any') as ParsedRule['field'];
        try {
          const regex = new RegExp(m[2], m[3]);
          parsed.push({
            raw: r,
            field,
            regex,
            category: m[4].trim(),
            subcategory: m[5].trim(),
          });
        } catch {
          // Ignore malformed regex
        }
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Evaluates a book against `rules.json` and `taxonomy.json`.
 */
export function classifyBook(
  book: ExtractedBookMetadata,
  taxonomy: TaxonomyMap,
  rules: ParsedRule[]
): CategorizationMatch | null {
  // 1. Check Custom Regex Rules Engine (rules.json)
  for (const rule of rules) {
    let targetText = '';
    if (rule.field === 'title') targetText = book.title;
    else if (rule.field === 'author') targetText = book.author || '';
    else if (rule.field === 'bookmarks') targetText = book.bookmarksText;
    else if (rule.field === 'text') targetText = book.first300Words;
    else targetText = `${book.title} ${book.author || ''} ${book.bookmarksText} ${book.first300Words}`;

    if (rule.regex.test(targetText)) {
      return {
        category: rule.category,
        subcategory: rule.subcategory,
        confidence: 'rule',
        matchedRuleOrKeyword: rule.raw,
      };
    }
  }

  // 2. Scan internal PDF bookmarks, Table of Contents, and title keywords against taxonomy.json
  const combinedHaystack = `${book.title} ${book.bookmarksText} ${book.first300Words}`.toLowerCase();
  const titleLower = book.title.toLowerCase();

  let bestCategory = '';
  let bestSubcategory = '';
  let bestScore = 0;
  let bestKeyword = '';

  for (const [category, subMap] of Object.entries(taxonomy)) {
    for (const [subcategory, keywords] of Object.entries(subMap)) {
      let score = 0;
      let matchedKw = '';

      // Direct category/subcategory name match in title
      if (titleLower.includes(subcategory.toLowerCase())) {
        score += 6;
        matchedKw = subcategory;
      } else if (titleLower.includes(category.toLowerCase())) {
        score += 3;
        matchedKw = category;
      }

      for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        if (titleLower.includes(kwLower)) {
          score += 5;
          matchedKw = kw;
        } else if (combinedHaystack.includes(kwLower)) {
          score += 2;
          if (!matchedKw) matchedKw = kw;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCategory = category;
        bestSubcategory = subcategory;
        bestKeyword = matchedKw;
      }
    }
  }

  if (bestScore >= 2) {
    return {
      category: bestCategory,
      subcategory: bestSubcategory,
      confidence: 'taxonomy',
      matchedRuleOrKeyword: bestKeyword,
    };
  }

  return null;
}

/**
 * Interactive CLI prompt when no confident category matches:
 * `Assign category for "[Title]" (Choose from list or type 'NewCategory/NewSubcategory'): `
 */
export async function promptUserForCategory(
  title: string,
  taxonomy: TaxonomyMap,
  rl?: readline.Interface
): Promise<CategorizationMatch> {
  const options: Array<{ category: string; subcategory: string }> = [];
  for (const [cat, subs] of Object.entries(taxonomy)) {
    for (const sub of Object.keys(subs)) {
      options.push({ category: cat, subcategory: sub });
    }
  }

  console.log(`\nAvailable Categories for "${title}":`);
  options.slice(0, 12).forEach((opt, idx) => {
    console.log(`  [${idx + 1}] ${opt.category}/${opt.subcategory}`);
  });

  const promptText = `Assign category for "${title}" (Choose from list or type 'NewCategory/NewSubcategory'): `;

  const ask = (question: string): Promise<string> => {
    if (rl) {
      return new Promise((resolve) => rl.question(question, resolve));
    }
    const tempRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      tempRl.question(question, (ans) => {
        tempRl.close();
        resolve(ans);
      });
    });
  };

  const answer = (await ask(promptText)).trim();
  const numChoice = parseInt(answer, 10);
  if (!isNaN(numChoice) && numChoice >= 1 && numChoice <= options.length) {
    const picked = options[numChoice - 1];
    return {
      category: picked.category,
      subcategory: picked.subcategory,
      confidence: 'interactive',
    };
  }

  if (answer.includes('/')) {
    const [cat, sub] = answer.split('/').map((s) => s.trim());
    if (cat && sub) {
      if (!taxonomy[cat]) taxonomy[cat] = {};
      if (!taxonomy[cat][sub]) taxonomy[cat][sub] = [];
      return {
        category: cat,
        subcategory: sub,
        confidence: 'interactive',
      };
    }
  }

  if (answer) {
    return {
      category: answer,
      subcategory: 'General',
      confidence: 'interactive',
    };
  }

  return {
    category: 'Uncategorized',
    subcategory: 'General',
    confidence: 'fallback',
  };
}

/**
 * Sanitizes a filename segment for cross-platform safety (Windows/macOS/Linux).
 */
export function sanitizePathSegment(str: string): string {
  return str
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes the destination path for a book file:
 * `<DESTINATION_ROOT>/<Category>/<Subcategory>/[Cleaned_Title] - [Author].[ext]`
 */
export function buildDestinationFilePath(
  destRoot: string,
  category: string,
  subcategory: string,
  title: string,
  author: string | null,
  format: string
): string {
  const safeCat = sanitizePathSegment(category) || 'Uncategorized';
  const safeSub = sanitizePathSegment(subcategory) || 'General';
  const safeTitle = sanitizePathSegment(title) || 'Untitled Book';
  const safeAuthor = sanitizePathSegment(author || 'Unknown Author');
  const ext = format.toLowerCase().replace(/^\./, '');

  const fileName = `${safeTitle} - ${safeAuthor}.${ext}`;
  return path.join(destRoot, safeCat, safeSub, fileName);
}

/**
 * Resolves destination path collisions by appending a deterministic counter `(2)`, `(3)` if a different file exists at target.
 */
export function resolveCollisionSafePath(targetPath: string, sourceSha256: string): string {
  if (!fs.existsSync(targetPath)) {
    return targetPath;
  }

  // Check if the existing file is already the exact same SHA-256
  try {
    const existingBuf = fs.readFileSync(targetPath);
    const existingSha = crypto.createHash('sha256').update(existingBuf).digest('hex');
    if (existingSha === sourceSha256) {
      return targetPath;
    }
  } catch {
    // Continue to collision suffix
  }

  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);

  let counter = 2;
  while (true) {
    const candidate = path.join(dir, `${base} (${counter})${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    counter++;
  }
}

/**
 * Performs an atomic file move with cross-volume fallback and collision avoidance.
 */
export function atomicMoveFile(sourcePath: string, destinationPath: string, sourceSha256: string): string {
  const resolvedSource = path.resolve(sourcePath);
  const safeTarget = resolveCollisionSafePath(path.resolve(destinationPath), sourceSha256);

  if (resolvedSource === safeTarget) {
    return safeTarget;
  }

  const targetDir = path.dirname(safeTarget);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  try {
    fs.renameSync(resolvedSource, safeTarget);
  } catch (err: any) {
    // Handle EXDEV (cross-drive move on Windows/Linux) via temp file + atomic rename + unlink
    const tempTarget = `${safeTarget}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(resolvedSource, tempTarget);
    fs.renameSync(tempTarget, safeTarget);
    fs.unlinkSync(resolvedSource);
  }

  return safeTarget;
}

/**
 * Recursively removes empty directories inside `sourceRoot` (used when `--clean-empty` is passed).
 */
export function cleanEmptyDirectories(dirPath: string, isRoot = true): void {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;

  let entries = fs.readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      cleanEmptyDirectories(fullPath, false);
    }
  }

  if (!isRoot) {
    entries = fs.readdirSync(dirPath);
    if (entries.length === 0) {
      try {
        fs.rmdirSync(dirPath);
      } catch {
        // Ignore if locked
      }
    }
  }
}

/**
 * Executes a batch of planned file moves atomically, updates the SQLite index,
 * and writes an atomic undo journal batch (`undo_log`).
 */
export function executeBatchMoves(
  db: LibraryDatabase,
  moves: PlannedFileMove[],
  options: { cleanEmptySourceDirs?: boolean; sourceRoot?: string } = {}
): { batchId: string; movedCount: number; results: PlannedFileMove[] } {
  const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const completed: PlannedFileMove[] = [];

  for (const m of moves) {
    if (!fs.existsSync(m.sourcePath)) continue;

    const finalDest = atomicMoveFile(m.sourcePath, m.destinationPath, m.sha256);
    const fileId = db.upsertBookFile({
      book_id: m.bookId,
      format: m.format,
      file_path: finalDest,
      file_size_bytes: m.sizeBytes,
      sha256: m.sha256,
    });

    if (path.resolve(m.sourcePath) !== path.resolve(finalDest)) {
      db.logUndoEntry({
        batch_id: batchId,
        book_id: m.bookId,
        file_id: fileId,
        old_path: path.resolve(m.sourcePath),
        new_path: path.resolve(finalDest),
      });
    }

    completed.push({
      ...m,
      destinationPath: finalDest,
    });
  }

  if (options.cleanEmptySourceDirs && options.sourceRoot) {
    cleanEmptyDirectories(options.sourceRoot, true);
  }

  return {
    batchId,
    movedCount: completed.length,
    results: completed,
  };
}
