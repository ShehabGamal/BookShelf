import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface BookRecord {
  id: string; // SHA-256 of the primary file
  title: string;
  author: string | null;
  isbn: string | null;
  category: string;
  subcategory: string | null;
  language: string | null;
  translation_group_id: string | null;
  is_translation_variant: number;
  cover_path: string | null;
  has_cover_url_pending: string | null;
  created_at: string;
  formats?: string[];
  files?: BookFileRecord[];
}

export interface BookFileRecord {
  id: number;
  book_id: string;
  format: string;
  file_path: string;
  file_size_bytes: number;
  sha256: string;
}

export interface UndoEntry {
  id: number;
  batch_id: string;
  book_id: string;
  file_id: number;
  old_path: string;
  new_path: string;
  created_at: string;
  reverted: number;
}

export interface DuplicateRecord {
  id: number;
  sha256: string;
  primary_path: string;
  duplicate_path: string;
  file_size_bytes: number;
  detected_at: string;
}

export class LibraryDatabase {
  public db: Database.Database;
  public dbPath: string;
  public rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir || process.cwd();
    const dataDir = path.join(this.rootDir, '.booktrack');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.dbPath = path.join(dataDir, 'library.db');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  public migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,               -- SHA-256 of the primary PDF/ebook
        title TEXT NOT NULL,
        author TEXT,
        isbn TEXT,
        category TEXT NOT NULL,
        subcategory TEXT,
        language TEXT,
        translation_group_id TEXT,
        is_translation_variant INTEGER DEFAULT 0,
        cover_path TEXT,
        has_cover_url_pending TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS book_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
        format TEXT NOT NULL,              -- 'pdf', 'epub', 'mobi', 'djvu'
        file_path TEXT NOT NULL UNIQUE,
        file_size_bytes INTEGER NOT NULL,
        sha256 TEXT
      );

      CREATE TABLE IF NOT EXISTS undo_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        file_id INTEGER,
        old_path TEXT NOT NULL,
        new_path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reverted INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS duplicate_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL,
        primary_path TEXT NOT NULL,
        duplicate_path TEXT NOT NULL UNIQUE,
        file_size_bytes INTEGER NOT NULL,
        detected_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_books_category ON books(category, subcategory);
      CREATE INDEX IF NOT EXISTS idx_book_files_book_id ON book_files(book_id);
      CREATE INDEX IF NOT EXISTS idx_book_files_sha256 ON book_files(sha256);
    `);
  }

  public setSetting(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value);
  }

  public getSetting(key: string, fallback = ''): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : fallback;
  }

  public upsertBook(book: Omit<BookRecord, 'created_at' | 'formats' | 'files'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO books (
        id, title, author, isbn, category, subcategory, language,
        translation_group_id, is_translation_variant, cover_path, has_cover_url_pending
      ) VALUES (
        @id, @title, @author, @isbn, @category, @subcategory, @language,
        @translation_group_id, @is_translation_variant, @cover_path, @has_cover_url_pending
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        author = COALESCE(excluded.author, books.author),
        isbn = COALESCE(excluded.isbn, books.isbn),
        category = excluded.category,
        subcategory = excluded.subcategory,
        language = COALESCE(excluded.language, books.language),
        translation_group_id = COALESCE(excluded.translation_group_id, books.translation_group_id),
        is_translation_variant = excluded.is_translation_variant,
        cover_path = COALESCE(excluded.cover_path, books.cover_path),
        has_cover_url_pending = excluded.has_cover_url_pending
    `);
    stmt.run(book);
  }

  public upsertBookFile(file: {
    book_id: string;
    format: string;
    file_path: string;
    file_size_bytes: number;
    sha256: string;
  }): number {
    const existing = this.db
      .prepare('SELECT id FROM book_files WHERE book_id = ? AND format = ?')
      .get(file.book_id, file.format) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE book_files SET file_path = ?, file_size_bytes = ?, sha256 = ? WHERE id = ?')
        .run(file.file_path, file.file_size_bytes, file.sha256, existing.id);
      return existing.id;
    }

    const byPath = this.db
      .prepare('SELECT id FROM book_files WHERE file_path = ?')
      .get(file.file_path) as { id: number } | undefined;

    if (byPath) {
      this.db
        .prepare('UPDATE book_files SET book_id = ?, format = ?, file_size_bytes = ?, sha256 = ? WHERE id = ?')
        .run(file.book_id, file.format, file.file_size_bytes, file.sha256, byPath.id);
      return byPath.id;
    }

    const info = this.db
      .prepare(
        'INSERT INTO book_files (book_id, format, file_path, file_size_bytes, sha256) VALUES (?, ?, ?, ?, ?)'
      )
      .run(file.book_id, file.format, file.file_path, file.file_size_bytes, file.sha256);
    return Number(info.lastInsertRowid);
  }

  public updateFilePath(fileId: number, newPath: string): void {
    this.db.prepare('UPDATE book_files SET file_path = ? WHERE id = ?').run(newPath, fileId);
  }

  public recordDuplicate(sha256: string, primaryPath: string, duplicatePath: string, sizeBytes: number): void {
    if (primaryPath === duplicatePath) return;
    this.db
      .prepare(`
        INSERT INTO duplicate_files (sha256, primary_path, duplicate_path, file_size_bytes)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(duplicate_path) DO UPDATE SET
          sha256 = excluded.sha256,
          primary_path = excluded.primary_path,
          file_size_bytes = excluded.file_size_bytes,
          detected_at = CURRENT_TIMESTAMP
      `)
      .run(sha256, primaryPath, duplicatePath, sizeBytes);
  }

  public getAllBooks(): BookRecord[] {
    const books = this.db
      .prepare('SELECT * FROM books ORDER BY category ASC, subcategory ASC, title ASC')
      .all() as BookRecord[];
    const files = this.db.prepare('SELECT * FROM book_files ORDER BY format ASC').all() as BookFileRecord[];

    const filesByBook = new Map<string, BookFileRecord[]>();
    for (const f of files) {
      const list = filesByBook.get(f.book_id) || [];
      list.push(f);
      filesByBook.set(f.book_id, list);
    }

    return books.map((b) => {
      const bookFiles = filesByBook.get(b.id) || [];
      const uniqueFormats = Array.from(new Set(bookFiles.map((f) => f.format.toLowerCase())));
      return {
        ...b,
        formats: uniqueFormats,
        files: bookFiles,
      };
    });
  }

  public getBookById(id: string): BookRecord | undefined {
    const book = this.db.prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRecord | undefined;
    if (!book) return undefined;
    const files = this.db
      .prepare('SELECT * FROM book_files WHERE book_id = ? ORDER BY format ASC')
      .all(id) as BookFileRecord[];
    return {
      ...book,
      formats: Array.from(new Set(files.map((f) => f.format.toLowerCase()))),
      files,
    };
  }

  public updateTranslationVariants(): void {
    const books = this.db.prepare('SELECT id, title, isbn, language FROM books').all() as Array<{
      id: string;
      title: string;
      isbn: string | null;
      language: string | null;
    }>;

    // Group by ISBN or normalized canonical title
    const groups = new Map<string, Array<{ id: string; language: string | null }>>();
    for (const b of books) {
      const key = b.isbn
        ? `isbn:${b.isbn.replace(/[^0-9X]/gi, '')}`
        : `title:${b.title.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, ' ').trim()}`;
      const list = groups.get(key) || [];
      list.push({ id: b.id, language: b.language });
      groups.set(key, list);
    }

    const updateStmt = this.db.prepare(
      'UPDATE books SET translation_group_id = ?, is_translation_variant = ? WHERE id = ?'
    );

    for (const [groupKey, members] of groups.entries()) {
      const distinctLangs = new Set(members.map((m) => (m.language || 'UND').toUpperCase()));
      const isVariant = members.length > 1 && distinctLangs.size > 1 ? 1 : 0;
      for (const m of members) {
        updateStmt.run(isVariant ? groupKey : null, isVariant, m.id);
      }
    }
  }

  public logUndoEntry(entry: {
    batch_id: string;
    book_id: string;
    file_id: number;
    old_path: string;
    new_path: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO undo_log (batch_id, book_id, file_id, old_path, new_path) VALUES (@batch_id, @book_id, @file_id, @old_path, @new_path)'
      )
      .run(entry);
  }

  public getUndoBatches(): Array<{
    batch_id: string;
    created_at: string;
    reverted: number;
    move_count: number;
    entries: UndoEntry[];
  }> {
    const rows = this.db
      .prepare('SELECT * FROM undo_log ORDER BY id DESC')
      .all() as UndoEntry[];

    const batchMap = new Map<
      string,
      { batch_id: string; created_at: string; reverted: number; move_count: number; entries: UndoEntry[] }
    >();

    for (const r of rows) {
      let group = batchMap.get(r.batch_id);
      if (!group) {
        group = {
          batch_id: r.batch_id,
          created_at: r.created_at,
          reverted: r.reverted,
          move_count: 0,
          entries: [],
        };
        batchMap.set(r.batch_id, group);
      }
      group.move_count++;
      group.entries.push(r);
    }

    return Array.from(batchMap.values());
  }

  public markBatchReverted(batchId: string): void {
    this.db.prepare('UPDATE undo_log SET reverted = 1 WHERE batch_id = ?').run(batchId);
  }

  public getDuplicates(): DuplicateRecord[] {
    return this.db.prepare('SELECT * FROM duplicate_files ORDER BY detected_at DESC').all() as DuplicateRecord[];
  }

  public findExistingFileBySha256(sha256: string): BookFileRecord | undefined {
    return this.db
      .prepare('SELECT * FROM book_files WHERE sha256 = ? LIMIT 1')
      .get(sha256) as BookFileRecord | undefined;
  }

  public close(): void {
    this.db.close();
  }
}
