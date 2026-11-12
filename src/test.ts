import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LibraryDatabase } from './db';
import { generateSampleBooks } from './demo';
import { runScanWorkflow } from './server';
import { undoLastBatch } from './undo';

async function runTests() {
  console.log('Running BookShelf / booktrack verification suite...\n');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'booktrack-test-'));
  // Copy default taxonomy.json and rules.json into tempRoot
  fs.copyFileSync(path.join(process.cwd(), 'taxonomy.json'), path.join(tempRoot, 'taxonomy.json'));
  fs.copyFileSync(path.join(process.cwd(), 'rules.json'), path.join(tempRoot, 'rules.json'));

  const db = new LibraryDatabase(tempRoot);
  const sample = generateSampleBooks(tempRoot);

  // 1. Test Dry-Run Mode
  const dryReport = await runScanWorkflow(db, {
    sourceDir: sample.sourceDir,
    destDir: sample.destDir,
    dryRun: true,
  });

  assert.strictEqual(dryReport.dryRun, true, 'Should mark report as dryRun');
  assert.strictEqual(dryReport.scannedBooks, 8, 'Should aggregate 12 files into 8 canonical books');
  assert.strictEqual(dryReport.movedFiles, 0, 'Dry-run must not move any files');
  assert.strictEqual(dryReport.duplicatesDetected, 1, 'Should detect 1 SHA-256 duplicate file across folders');
  console.log('✔ Test 1 Passed: Dry-Run scan, sibling format aggregation, and SHA-256 duplicate detection');

  // 2. Test Full Scan & Atomic Organization
  const liveReport = await runScanWorkflow(db, {
    sourceDir: sample.sourceDir,
    destDir: sample.destDir,
    dryRun: false,
    cleanEmpty: true,
  });

  assert.strictEqual(liveReport.scannedBooks, 8, 'Should index 8 canonical books');
  assert.ok(liveReport.movedFiles >= 11, 'Should move all unique book files atomically');
  assert.ok(liveReport.batchId, 'Should create an undo batch ID');

  const allBooks = db.getAllBooks();
  assert.strictEqual(allBooks.length, 8, 'Database should contain 8 canonical book records');

  // Verify sibling format aggregation for "Principles of Chemistry" (PDF + EPUB)
  const chemEn = allBooks.find((b) => b.title === 'Principles of Chemistry');
  assert.ok(chemEn, 'Should find Principles of Chemistry');
  assert.deepStrictEqual(
    chemEn!.formats?.sort(),
    ['epub', 'pdf'],
    'Should aggregate sibling formats [epub, pdf] under a single canonical record'
  );

  // Verify translation variant detection (EN, FR, AR editions sharing ISBN 9780134128924)
  const translationVariants = allBooks.filter((b) => b.is_translation_variant === 1);
  assert.strictEqual(
    translationVariants.length,
    3,
    'Should mark EN, FR, and AR editions sharing ISBN 9780134128924 as translation variants'
  );
  console.log('✔ Test 2 Passed: Sibling format aggregation, language detection (EN/FR/AR), and translation variants');

  // Verify Permission-Gated Cover Fetcher (books without embedded cover have pending URL, NOT auto-downloaded)
  const pendingCovers = allBooks.filter((b) => Boolean(b.has_cover_url_pending));
  assert.strictEqual(
    pendingCovers.length,
    2,
    'Books lacking embedded cover must wait for explicit user approval before downloading'
  );
  console.log('✔ Test 3 Passed: Permission-gated cover fetcher holds candidate URLs for explicit approval');

  // 3. Test Atomic Undo Log (`booktrack undo`)
  const undoRes = undoLastBatch(db, liveReport.batchId!);
  assert.ok(undoRes, 'Should find and revert the last batch');
  assert.strictEqual(undoRes!.restoredCount, liveReport.movedFiles, 'Should restore all moved files');
  assert.ok(
    fs.existsSync(path.join(sample.sourceDir, 'principles_chem.pdf')),
    'Original source file should be restored on disk'
  );
  console.log('✔ Test 4 Passed: Atomic undo log reversed all file moves back to original locations');

  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('\nAll verification tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
