#!/usr/bin/env node
import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { LibraryDatabase } from './db';
import { aggregateAndInspectDirectory } from './scanner';
import {
  loadTaxonomy,
  saveTaxonomy,
  loadRules,
  classifyBook,
  promptUserForCategory,
  buildDestinationFilePath,
  executeBatchMoves,
  PlannedFileMove,
} from './categorizer';
import {
  extractLocalCoverToCache,
  findCandidateCoverUrl,
  promptUserForCoverApproval,
  downloadApprovedCover,
} from './covers';
import { undoLastBatch } from './undo';
import { createDashboardServer } from './server';
import { generateSampleBooks } from './demo';

const program = new Command();

program
  .name('booktrack')
  .description('Local PDF Library Organizer, Metadata Tracker & Interactive Dashboard')
  .version('1.0.0');

// 1. booktrack init --library-dir /path/to/destination
program
  .command('init')
  .description('Initialize SQLite database, cache folders, and default library destination')
  .requiredOption('-l, --library-dir <path>', 'Target root directory for organized books')
  .action((options) => {
    const rootDir = process.cwd();
    const resolvedDest = path.resolve(options.libraryDir);
    if (!fs.existsSync(resolvedDest)) {
      fs.mkdirSync(resolvedDest, { recursive: true });
    }

    const db = new LibraryDatabase(rootDir);
    db.setSetting('library_dir', resolvedDest);

    console.log('✔ BookShelf / booktrack initialized successfully!');
    console.log(`  Database : ${db.dbPath}`);
    console.log(`  Library  : ${resolvedDest}`);
    db.close();
  });

// 2. booktrack scan /path/to/downloads [--dest /path/to/library] [--interactive] [--dry-run] [--clean-empty]
program
  .command('scan')
  .description('Recursively scan a directory, aggregate sibling formats, detect languages, and organize books')
  .argument('<source>', 'Input folder path to scan for PDF/EPUB/MOBI/DJVU files')
  .option('-d, --dest <path>', 'Destination library root folder')
  .option('-i, --interactive', 'Prompt interactively for missing covers and uncertain categories', false)
  .option('--dry-run', 'Preview proposed categories, formats, and file moves without touching disk', false)
  .option('--clean-empty', 'Remove empty source directories after moving files', false)
  .action(async (source, options) => {
    const rootDir = process.cwd();
    const sourceDir = path.resolve(source);

    if (!fs.existsSync(sourceDir)) {
      console.error(`✖ Error: Source directory does not exist: ${sourceDir}`);
      process.exit(1);
    }

    const db = new LibraryDatabase(rootDir);
    const defaultDest = db.getSetting('library_dir', path.join(rootDir, 'sample-library'));
    const destDir = path.resolve(options.dest || defaultDest);
    const dryRun = Boolean(options.dryRun);
    const interactive = Boolean(options.interactive);
    const cleanEmpty = Boolean(options.cleanEmpty);

    if (!dryRun) {
      db.setSetting('last_source_dir', sourceDir);
      if (options.dest) {
        db.setSetting('library_dir', destDir);
      }
    }

    console.log(`\nScanning directory: ${sourceDir}`);
    if (dryRun) {
      console.log('Mode: DRY-RUN (no files will be moved or modified on disk)\n');
    }

    let duplicateCount = 0;
    const extractedBooks = await aggregateAndInspectDirectory(
      sourceDir,
      (sha256, primaryPath, duplicatePath, sizeBytes) => {
        duplicateCount++;
        console.log(
          `  [DUPLICATE SHA-256] ${path.basename(duplicatePath)} matches ${path.basename(primaryPath)} (${sha256.slice(
            0,
            12
          )}...)`
        );
        if (!dryRun) {
          db.recordDuplicate(sha256, primaryPath, duplicatePath, sizeBytes);
        }
      }
    );

    if (extractedBooks.length === 0) {
      console.log('No supported book files (.pdf, .epub, .mobi, .djvu) found.');
      db.close();
      return;
    }

    const taxonomy = loadTaxonomy(rootDir);
    const rules = loadRules(rootDir);
    const rl = interactive
      ? readline.createInterface({ input: process.stdin, output: process.stdout })
      : undefined;

    const plannedMoves: PlannedFileMove[] = [];

    console.log(`Found ${extractedBooks.length} canonical book record(s):\n`);

    for (const book of extractedBooks) {
      let match = classifyBook(book, taxonomy, rules);
      if (!match) {
        if (interactive && rl) {
          match = await promptUserForCategory(book.title, taxonomy, rl);
          saveTaxonomy(rootDir, taxonomy);
        } else {
          match = {
            category: 'Uncategorized',
            subcategory: 'General',
            confidence: 'fallback',
          };
        }
      }

      let coverPath: string | null = null;
      let pendingCoverUrl: string | null = null;

      if (book.hasEmbeddedCover) {
        if (!dryRun) {
          const cached = extractLocalCoverToCache(rootDir, book.canonicalId, book.files[0].filePath, {
            title: book.title,
            author: book.author,
            category: match.category,
            language: book.language,
          });
          coverPath = `/covers/${path.basename(cached)}`;
        }
      } else {
        const candidateUrl = await findCandidateCoverUrl({
          title: book.title,
          author: book.author,
          isbn: book.isbn,
        });

        if (interactive && rl && !dryRun) {
          const approval = await promptUserForCoverApproval(book.title, candidateUrl, rl);
          if (approval.approved) {
            const downloaded = await downloadApprovedCover(
              rootDir,
              book.canonicalId,
              approval.finalUrl,
              {
                title: book.title,
                author: book.author,
                category: match.category,
              }
            );
            coverPath = `/covers/${path.basename(downloaded)}`;
          } else {
            pendingCoverUrl = candidateUrl;
          }
        } else {
          pendingCoverUrl = candidateUrl;
        }
      }

      const bookMoves: PlannedFileMove[] = book.files.map((f) => ({
        bookId: book.canonicalId,
        title: book.title,
        author: book.author,
        category: match!.category,
        subcategory: match!.subcategory,
        format: f.format,
        sourcePath: f.filePath,
        destinationPath: buildDestinationFilePath(
          destDir,
          match!.category,
          match!.subcategory,
          book.title,
          book.author,
          f.format
        ),
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
      }));

      plannedMoves.push(...bookMoves);

      // Print formatted report entry
      console.log(`• "${book.title}" by ${book.author || 'Unknown Author'}`);
      console.log(`    Local Formats : [${book.formats.map((f) => f.toUpperCase()).join(', ')}]`);
      console.log(`    Language      : ${book.language} (via ${book.languageSource})`);
      if (book.isbn) console.log(`    ISBN          : ${book.isbn}`);
      console.log(`    Category      : ${match.category} -> ${match.subcategory} (${match.confidence})`);
      console.log(
        `    Cover Status  : ${
          book.hasEmbeddedCover
            ? 'Embedded Local Cover Extracted'
            : coverPath
            ? 'Approved & Downloaded'
            : `Pending User Approval (${pendingCoverUrl})`
        }`
      );
      for (const m of bookMoves) {
        console.log(`    [${m.format.toUpperCase()}] ${m.sourcePath}`);
        console.log(`      -> ${m.destinationPath}`);
      }
      console.log('');

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
          cover_path: coverPath,
          has_cover_url_pending: coverPath ? null : pendingCoverUrl,
        });
      }
    }

    if (rl) rl.close();

    if (dryRun) {
      console.log(
        `✔ Dry-Run complete: ${extractedBooks.length} book(s), ${plannedMoves.length} proposed file move(s), ${duplicateCount} duplicate(s). No files were modified.`
      );
    } else {
      const batchResult = executeBatchMoves(db, plannedMoves, {
        cleanEmptySourceDirs: cleanEmpty,
        sourceRoot: sourceDir,
      });
      db.updateTranslationVariants();
      console.log(
        `✔ Scan & Organize complete: ${batchResult.movedCount} file(s) moved atomically (Undo Batch ID: ${batchResult.batchId}).`
      );
    }

    db.close();
  });

// 3. booktrack undo [--batch <id>]
program
  .command('undo')
  .description('Reverse the last batch of file relocations using the atomic undo journal')
  .option('-b, --batch <id>', 'Specific batch ID to revert')
  .action((options) => {
    const db = new LibraryDatabase(process.cwd());
    const result = undoLastBatch(db, options.batch);

    if (!result) {
      console.log('No active relocation batches found to undo.');
      db.close();
      return;
    }

    console.log(`✔ Reverted batch ${result.batchId} (${result.restoredCount} file(s) restored):`);
    for (const item of result.details) {
      console.log(`  ${item.from} -> ${item.to}`);
    }
    db.close();
  });

// 4. booktrack ui [--port 4080]
program
  .command('ui')
  .description('Launch the local interactive web dashboard')
  .option('-p, --port <number>', 'Port to bind on 127.0.0.1', '4080')
  .action((options) => {
    const port = parseInt(options.port, 10) || 4080;
    const db = new LibraryDatabase(process.cwd());
    const app = createDashboardServer(db);

    app.listen(port, '127.0.0.1', () => {
      console.log(`\n=============================================================`);
      console.log(`  BookShelf Local Dashboard running at http://127.0.0.1:${port}`);
      console.log(`  Database: ${db.dbPath}`);
      console.log(`  Press Ctrl+C to stop the server.`);
      console.log(`=============================================================\n`);
    });
  });

// 5. booktrack list
program
  .command('list')
  .description('List all indexed books in the local SQLite database')
  .option('-c, --category <name>', 'Filter by category')
  .option('-f, --format <ext>', 'Filter by local format (pdf, epub, mobi, djvu)')
  .action((options) => {
    const db = new LibraryDatabase(process.cwd());
    let books = db.getAllBooks();

    if (options.category) {
      books = books.filter((b) => b.category.toLowerCase() === options.category.toLowerCase());
    }
    if (options.format) {
      books = books.filter((b) => (b.formats || []).includes(options.format.toLowerCase()));
    }

    if (books.length === 0) {
      console.log('No indexed books match the criteria.');
      db.close();
      return;
    }

    console.log(`\nIndexed Local Books (${books.length}):\n`);
    for (const b of books) {
      const fmts = (b.formats || []).map((f) => f.toUpperCase()).join(', ');
      const variantTag = b.is_translation_variant ? ' [TRANSLATION VARIANT]' : '';
      console.log(
        `• [${b.category}/${b.subcategory}] "${b.title}" — ${b.author || 'Unknown'} (${
          b.language
        }) [${fmts}]${variantTag}`
      );
    }
    console.log('');
    db.close();
  });

// 6. booktrack demo
program
  .command('demo')
  .description('Generate sample multi-format books (PDF, EPUB, MOBI, DJVU) for testing')
  .action(() => {
    const rootDir = process.cwd();
    const res = generateSampleBooks(rootDir);
    console.log(`✔ Generated ${res.createdFiles.length} sample book files in: ${res.sourceDir}`);
    console.log(`  Try running:`);
    console.log(`    node dist/cli.js scan "${res.sourceDir}" --dry-run`);
    console.log(`    node dist/cli.js scan "${res.sourceDir}" --dest "${res.destDir}"`);
    console.log(`    node dist/cli.js ui --port 4080`);
  });

program.parse(process.argv);
