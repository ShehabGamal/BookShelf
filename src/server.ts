import express from 'express';
import path from 'path';
import fs from 'fs';
import { LibraryDatabase } from './db';
import { aggregateAndInspectDirectory } from './scanner';
import {
  loadTaxonomy,
  saveTaxonomy,
  loadRules,
  classifyBook,
  buildDestinationFilePath,
  executeBatchMoves,
  PlannedFileMove,
} from './categorizer';
import {
  extractLocalCoverToCache,
  findCandidateCoverUrl,
  downloadApprovedCover,
  getCoversCacheDir,
} from './covers';
import { undoLastBatch } from './undo';
import { generateSampleBooks } from './demo';

export interface ScanItemReport {
  bookId: string;
  title: string;
  author: string | null;
  isbn: string | null;
  language: string;
  languageSource: string;
  category: string;
  subcategory: string;
  confidence: string;
  matchedRuleOrKeyword?: string;
  formats: string[];
  hasEmbeddedCover: boolean;
  pendingCoverUrl: string | null;
  plannedMoves: Array<{
    format: string;
    from: string;
    to: string;
    sizeBytes: number;
  }>;
}

export async function runScanWorkflow(
  db: LibraryDatabase,
  options: {
    sourceDir: string;
    destDir?: string;
    dryRun?: boolean;
    cleanEmpty?: boolean;
  }
): Promise<{
  dryRun: boolean;
  sourceDir: string;
  destDir: string;
  scannedBooks: number;
  movedFiles: number;
  batchId: string | null;
  duplicatesDetected: number;
  items: ScanItemReport[];
}> {
  const rootDir = db.rootDir;
  const sourceDir = path.resolve(options.sourceDir);
  const configuredDest = db.getSetting('library_dir', path.join(rootDir, 'library'));
  const destDir = path.resolve(options.destDir || configuredDest);
  const dryRun = Boolean(options.dryRun);

  let duplicatesDetected = 0;
  const extractedBooks = await aggregateAndInspectDirectory(
    sourceDir,
    (sha256, primaryPath, duplicatePath, sizeBytes) => {
      duplicatesDetected++;
      if (!dryRun) {
        db.recordDuplicate(sha256, primaryPath, duplicatePath, sizeBytes);
      }
    }
  );

  const taxonomy = loadTaxonomy(rootDir);
  const rules = loadRules(rootDir);

  const items: ScanItemReport[] = [];
  const allPlannedMoves: PlannedFileMove[] = [];

  for (const book of extractedBooks) {
    // Check if any file in this book is a duplicate of an already-indexed book in another location
    const existingByHash = db.findExistingFileBySha256(book.canonicalId);
    if (existingByHash && path.resolve(existingByHash.file_path) !== path.resolve(book.files[0].filePath)) {
      duplicatesDetected++;
      if (!dryRun) {
        db.recordDuplicate(
          book.canonicalId,
          existingByHash.file_path,
          book.files[0].filePath,
          book.files[0].sizeBytes
        );
      }
    }

    const match = classifyBook(book, taxonomy, rules) || {
      category: 'Uncategorized',
      subcategory: 'General',
      confidence: 'fallback' as const,
    };

    let coverPath: string | null = null;
    let pendingCoverUrl: string | null = null;

    if (book.hasEmbeddedCover) {
      if (!dryRun) {
        coverPath = extractLocalCoverToCache(rootDir, book.canonicalId, book.files[0].filePath, {
          title: book.title,
          author: book.author,
          category: match.category,
          language: book.language,
        });
      }
    } else {
      pendingCoverUrl = await findCandidateCoverUrl({
        title: book.title,
        author: book.author,
        isbn: book.isbn,
      });
    }

    const bookPlannedMoves: PlannedFileMove[] = book.files.map((f) => {
      const destPath = buildDestinationFilePath(
        destDir,
        match.category,
        match.subcategory,
        book.title,
        book.author,
        f.format
      );
      return {
        bookId: book.canonicalId,
        title: book.title,
        author: book.author,
        category: match.category,
        subcategory: match.subcategory,
        format: f.format,
        sourcePath: f.filePath,
        destinationPath: destPath,
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
      };
    });

    if (!dryRun) {
      db.upsertBook({
        id: book.canonicalId,
        title: book.title,
        author: book.author,
        isbn: book.isbn,
        category: match.category,
        subcategory: match.subcategory,
        language: book.language,
        translation_group_id: null,
        is_translation_variant: 0,
        cover_path: coverPath ? `/covers/${book.canonicalId}.webp` : null,
        has_cover_url_pending: coverPath ? null : pendingCoverUrl,
      });
    }

    allPlannedMoves.push(...bookPlannedMoves);

    items.push({
      bookId: book.canonicalId,
      title: book.title,
      author: book.author,
      isbn: book.isbn,
      language: book.language,
      languageSource: book.languageSource,
      category: match.category,
      subcategory: match.subcategory,
      confidence: match.confidence,
      matchedRuleOrKeyword: match.matchedRuleOrKeyword,
      formats: book.formats,
      hasEmbeddedCover: book.hasEmbeddedCover,
      pendingCoverUrl,
      plannedMoves: bookPlannedMoves.map((m) => ({
        format: m.format,
        from: m.sourcePath,
        to: m.destinationPath,
        sizeBytes: m.sizeBytes,
      })),
    });
  }

  let batchId: string | null = null;
  let movedFiles = 0;

  if (!dryRun && allPlannedMoves.length > 0) {
    const moveRes = executeBatchMoves(db, allPlannedMoves, {
      cleanEmptySourceDirs: options.cleanEmpty,
      sourceRoot: sourceDir,
    });
    batchId = moveRes.batchId;
    movedFiles = moveRes.movedCount;
    db.updateTranslationVariants();
  }

  return {
    dryRun,
    sourceDir,
    destDir,
    scannedBooks: items.length,
    movedFiles,
    batchId,
    duplicatesDetected,
    items,
  };
}

export function createDashboardServer(db: LibraryDatabase) {
  const app = express();
  const rootDir = db.rootDir;

  app.use(express.json({ limit: '2mb' }));

  // Serve cached cover thumbnails from `.cache/covers/[sha256].webp`
  const coversDir = getCoversCacheDir(rootDir);
  app.get('/covers/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const fullPath = path.join(coversDir, safeName);
    if (!fs.existsSync(fullPath)) {
      res.status(404).send('Cover not found');
      return;
    }
    const content = fs.readFileSync(fullPath);
    if (content.subarray(0, 64).toString('utf8').trim().startsWith('<svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
    } else if (content[0] === 0xff && content[1] === 0xd8) {
      res.setHeader('Content-Type', 'image/jpeg');
    } else {
      res.setHeader('Content-Type', 'image/webp');
    }
    res.send(content);
  });

  // Serve static frontend files from `public/`
  const publicDir = path.join(rootDir, 'public');
  app.use(express.static(publicDir));

  // GET /api/state - Full library state, category tree, settings, duplicates, and undo batches
  app.get('/api/state', (_req, res) => {
    const books = db.getAllBooks();
    const duplicates = db.getDuplicates();
    const undoBatches = db.getUndoBatches();
    const libraryDir = db.getSetting('library_dir', path.join(rootDir, 'sample-library'));
    const lastSourceDir = db.getSetting('last_source_dir', path.join(rootDir, 'sample-downloads'));

    // Build Category -> Subcategory hierarchy with live counts
    const categoryTree: Record<
      string,
      { count: number; subcategories: Record<string, number> }
    > = {};

    for (const b of books) {
      const cat = b.category || 'Uncategorized';
      const sub = b.subcategory || 'General';
      if (!categoryTree[cat]) {
        categoryTree[cat] = { count: 0, subcategories: {} };
      }
      categoryTree[cat].count++;
      categoryTree[cat].subcategories[sub] = (categoryTree[cat].subcategories[sub] || 0) + 1;
    }

    res.json({
      books,
      categoryTree,
      duplicates,
      undoBatches,
      settings: {
        libraryDir,
        lastSourceDir,
        rootDir,
      },
    });
  });

  // POST /api/scan - Trigger interactive scan or dry-run from Dashboard UI
  app.post('/api/scan', async (req, res) => {
    try {
      const { sourceDir, destDir, dryRun, cleanEmpty } = req.body || {};
      if (!sourceDir || typeof sourceDir !== 'string') {
        res.status(400).json({ error: 'Source directory path is required.' });
        return;
      }
      if (!fs.existsSync(sourceDir)) {
        res.status(400).json({ error: `Source directory does not exist on disk: ${sourceDir}` });
        return;
      }

      db.setSetting('last_source_dir', path.resolve(sourceDir));
      if (destDir && typeof destDir === 'string') {
        db.setSetting('library_dir', path.resolve(destDir));
      }

      const report = await runScanWorkflow(db, {
        sourceDir,
        destDir,
        dryRun: Boolean(dryRun),
        cleanEmpty: Boolean(cleanEmpty),
      });

      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Scan failed' });
    }
  });

  // POST /api/books/:id/approve-cover - Permission-gated cover approval / custom URL download
  app.post('/api/books/:id/approve-cover', async (req, res) => {
    try {
      const bookId = req.params.id;
      const { action, customUrl } = req.body || {};
      const book = db.getBookById(bookId);
      if (!book) {
        res.status(404).json({ error: 'Book not found' });
        return;
      }

      if (action === 'reject') {
        db.upsertBook({
          ...book,
          has_cover_url_pending: null,
        });
        res.json({ status: 'rejected', book: db.getBookById(bookId) });
        return;
      }

      const targetUrl = (customUrl && customUrl.trim()) || book.has_cover_url_pending;
      if (!targetUrl) {
        res.status(400).json({ error: 'No candidate or custom cover URL provided.' });
        return;
      }

      await downloadApprovedCover(rootDir, book.id, targetUrl, {
        title: book.title,
        author: book.author,
        category: book.category,
      });

      db.upsertBook({
        ...book,
        cover_path: `/covers/${book.id}.webp`,
        has_cover_url_pending: null,
      });

      res.json({ status: 'approved', book: db.getBookById(bookId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Cover approval failed' });
    }
  });

  // POST /api/books/:id/recategorize - Reassign Category/Subcategory and atomically move files
  app.post('/api/books/:id/recategorize', (req, res) => {
    try {
      const bookId = req.params.id;
      const { category, subcategory } = req.body || {};
      const book = db.getBookById(bookId);
      if (!book) {
        res.status(404).json({ error: 'Book not found' });
        return;
      }

      const newCat = (category || 'Uncategorized').trim();
      const newSub = (subcategory || 'General').trim();
      const destRoot = db.getSetting('library_dir', path.join(rootDir, 'sample-library'));

      const moves: PlannedFileMove[] = (book.files || []).map((f) => ({
        bookId: book.id,
        title: book.title,
        author: book.author,
        category: newCat,
        subcategory: newSub,
        format: f.format,
        sourcePath: f.file_path,
        destinationPath: buildDestinationFilePath(destRoot, newCat, newSub, book.title, book.author, f.format),
        sizeBytes: f.file_size_bytes,
        sha256: f.sha256,
      }));

      executeBatchMoves(db, moves);
      db.upsertBook({
        ...book,
        category: newCat,
        subcategory: newSub,
      });

      res.json({ status: 'updated', book: db.getBookById(bookId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Recategorization failed' });
    }
  });

  // POST /api/undo - Undo the latest (or specified) file relocation batch
  app.post('/api/undo', (req, res) => {
    try {
      const { batchId } = req.body || {};
      const result = undoLastBatch(db, batchId);
      if (!result) {
        res.status(400).json({ error: 'No active batch found to undo.' });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Undo failed' });
    }
  });

  // GET & PUT /api/rules-taxonomy - View and edit `rules.json` and `taxonomy.json`
  app.get('/api/rules-taxonomy', (_req, res) => {
    const taxonomy = loadTaxonomy(rootDir);
    const rulesPath = path.join(rootDir, 'rules.json');
    let rulesRaw = { rules: [] as string[] };
    if (fs.existsSync(rulesPath)) {
      try {
        rulesRaw = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      } catch {
        // Fallback
      }
    }
    res.json({ taxonomy, rules: rulesRaw.rules || [] });
  });

  app.put('/api/rules-taxonomy', (req, res) => {
    try {
      const { taxonomy, rules } = req.body || {};
      if (taxonomy && typeof taxonomy === 'object') {
        saveTaxonomy(rootDir, taxonomy);
      }
      if (Array.isArray(rules)) {
        const rulesPath = path.join(rootDir, 'rules.json');
        fs.writeFileSync(
          rulesPath,
          JSON.stringify(
            {
              description:
                "Custom regex rules for automated book categorization. Syntax: '<field> =~ /<pattern>/<flags> -> <Category>/<Subcategory>'",
              rules,
            },
            null,
            2
          ),
          'utf8'
        );
      }
      res.json({ status: 'saved' });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to save rules/taxonomy' });
    }
  });

  // POST /api/demo - Generate sample books on disk so users can test scanning & organizing in 1 click
  app.post('/api/demo', (_req, res) => {
    try {
      const generated = generateSampleBooks(rootDir);
      db.setSetting('last_source_dir', generated.sourceDir);
      db.setSetting('library_dir', generated.destDir);
      res.json(generated);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate sample books' });
    }
  });

  return app;
}
