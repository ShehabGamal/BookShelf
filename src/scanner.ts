import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
// @ts-ignore
import pdfParse from 'pdf-parse';

export const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.epub', '.mobi', '.djvu']);

export interface ScannedFileInfo {
  filePath: string;
  dirPath: string;
  baseName: string; // filename without extension
  normalizedBase: string;
  format: string; // 'pdf' | 'epub' | 'mobi' | 'djvu'
  sizeBytes: number;
  sha256: string;
}

export interface ExtractedBookMetadata {
  canonicalId: string; // SHA-256 of primary file
  title: string;
  author: string | null;
  isbn: string | null;
  language: string; // 'EN', 'FR', 'AR', 'ES', 'DE', etc.
  languageSource: 'metadata' | 'ngram-300w';
  bookmarksText: string;
  first300Words: string;
  hasEmbeddedCover: boolean;
  files: ScannedFileInfo[];
  formats: string[]; // Strictly local formats detected on disk
}

/**
 * Computes SHA-256 hash of a file on disk.
 */
export function computeFileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}

/**
 * Recursively walks an input folder and returns all supported book files physically present on disk.
 */
export function walkDirectoryForBooks(dirPath: string): ScannedFileInfo[] {
  const results: ScannedFileInfo[] = [];
  if (!fs.existsSync(dirPath)) {
    return results;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const subDirs: string[] = [];

  // Process files in the current directory first before descending into subdirectories
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      subDirs.push(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        const stat = fs.statSync(fullPath);
        const baseName = path.basename(entry.name, path.extname(entry.name));
        results.push({
          filePath: fullPath,
          dirPath: path.dirname(fullPath),
          baseName,
          normalizedBase: baseName.toLowerCase().trim(),
          format: ext.slice(1),
          sizeBytes: stat.size,
          sha256: computeFileSha256(fullPath),
        });
      }
    }
  }

  for (const sub of subDirs) {
    results.push(...walkDirectoryForBooks(sub));
  }

  return results;
}

/**
 * Local N-gram & Script Language Detector on the first 300 words of pages 1-2.
 */
export function detectLanguageFromText(text: string): string {
  const words = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 300)
    .join(' ');

  if (!words) return 'EN';

  // Script-level checks first (Arabic, Cyrillic, CJK)
  const arabicChars = (words.match(/[\u0600-\u06FF]/g) || []).length;
  if (arabicChars > 10) return 'AR';

  const cyrillicChars = (words.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillicChars > 10) return 'RU';

  const cjkChars = (words.match(/[\u4E00-\u9FFF]/g) || []).length;
  if (cjkChars > 5) return 'ZH';

  const lower = ` ${words.toLowerCase()} `;

  // Trigram & high-frequency function word profiles for Latin-script languages
  const profiles: Record<string, string[]> = {
    FR: [' le ', ' la ', ' les ', ' des ', ' une ', ' dans ', ' pour ', ' avec ', ' sur ', ' est ', ' sont ', ' chapitre ', ' principes ', ' chimie ', ' physique '],
    ES: [' el ', ' la ', ' los ', ' las ', ' una ', ' para ', ' con ', ' por ', ' del ', ' que ', ' capítulo ', ' edición '],
    DE: [' der ', ' die ', ' das ', ' und ', ' in ', ' den ', ' von ', ' mit ', ' auf ', ' für ', ' nicht ', ' kapitel ', ' auflage '],
    IT: [' il ', ' lo ', ' gli ', ' della ', ' nella ', ' con ', ' per ', ' sono ', ' capitolo '],
    PT: [' os ', ' as ', ' uma ', ' para ', ' com ', ' pelo ', ' pela ', ' são ', ' capítulo '],
    EN: [' the ', ' and ', ' of ', ' to ', ' in ', ' is ', ' for ', ' that ', ' with ', ' on ', ' as ', ' are ', ' this ', ' by ', ' chapter ', ' introduction ', ' edition '],
  };

  let bestLang = 'EN';
  let bestScore = 0;

  for (const [lang, tokens] of Object.entries(profiles)) {
    let score = 0;
    for (const token of tokens) {
      const matches = lower.split(token).length - 1;
      score += matches;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  return bestLang;
}

/**
 * Normalizes ISO language codes (e.g. 'en-US' -> 'EN', 'fr-FR' -> 'FR', 'ar-EG' -> 'AR').
 */
export function normalizeLangCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^['"(]+|['")]+$/g, '');
  if (!cleaned) return null;
  const prefix = cleaned.split(/[-_]/)[0].toUpperCase();
  const map: Record<string, string> = {
    EN: 'EN',
    ENG: 'EN',
    FR: 'FR',
    FRA: 'FR',
    FRE: 'FR',
    AR: 'AR',
    ARA: 'AR',
    ES: 'ES',
    SPA: 'ES',
    DE: 'DE',
    DEU: 'DE',
    GER: 'DE',
    RU: 'RU',
    RUS: 'RU',
    ZH: 'ZH',
    ZHO: 'ZH',
    CHI: 'ZH',
    IT: 'IT',
    ITA: 'IT',
    PT: 'PT',
    POR: 'PT',
  };
  return map[prefix] || (prefix.length === 2 ? prefix : null);
}

/**
 * Extracts ISBN-10 or ISBN-13 from raw document text or metadata.
 */
export function extractIsbn(text: string): string | null {
  const isbnRegex = /(?:ISBN(?:-1[03])?:?\s*)?(97[89][-\s]?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,6}[-\s]?\d|\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,6}[-\s]?[\dX])/i;
  const match = text.match(isbnRegex);
  if (!match) return null;
  const digits = match[1].replace(/[^0-9X]/gi, '').toUpperCase();
  if (digits.length === 10 || digits.length === 13) {
    return digits;
  }
  return null;
}

/**
 * Cleans up raw filenames into readable book titles and authors when embedded metadata is sparse.
 */
export function parseTitleAndAuthorFromFilename(baseName: string): { title: string; author: string | null } {
  // Remove common suffixes like (2nd ed), [v1], etc.
  const cleaned = baseName
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.includes(' - ')) {
    const parts = cleaned.split(' - ').map((p) => p.trim());
    if (parts.length >= 2) {
      return {
        title: toTitleCase(parts[0]),
        author: parts.slice(1).join(' - '),
      };
    }
  }

  return {
    title: toTitleCase(cleaned),
    author: null,
  };
}

function toTitleCase(str: string): string {
  // Preserve non-Latin characters (e.g. Arabic)
  if (/[\u0600-\u06FF]/.test(str)) return str;
  const minorWords = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'from', 'by', 'of', 'in']);
  return str
    .split(' ')
    .map((word, idx) => {
      if (!word) return word;
      const lower = word.toLowerCase();
      if (idx > 0 && minorWords.has(lower)) {
        return lower;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Inspects a single file (PDF, EPUB, MOBI, DJVU) for embedded metadata, /Lang, DC:language,
 * bookmarks/ToC, first 300 words of pages 1-2, and whether an image/cover resource is embedded.
 */
export async function inspectSingleFile(file: ScannedFileInfo): Promise<{
  title: string | null;
  author: string | null;
  isbn: string | null;
  embeddedLang: string | null;
  bookmarksText: string;
  first300Words: string;
  hasEmbeddedCover: boolean;
}> {
  const buffer = fs.readFileSync(file.filePath);
  const rawLatin = buffer.subarray(0, Math.min(buffer.length, 262144)).toString('latin1');
  const rawUtf8 = buffer.subarray(0, Math.min(buffer.length, 262144)).toString('utf8');

  let title: string | null = null;
  let author: string | null = null;
  let embeddedLang: string | null = null;
  let bookmarksText = '';
  let first300Words = '';
  let hasEmbeddedCover = false;

  // Check for embedded /Lang or DC:language tags in PDF/EPUB headers
  const pdfLangMatch = rawLatin.match(/\/Lang\s*\(([^)]+)\)/i);
  const dcLangMatch = rawUtf8.match(/<dc:language[^>]*>([^<]+)<\/dc:language>/i);
  if (pdfLangMatch) {
    embeddedLang = normalizeLangCode(pdfLangMatch[1]);
  } else if (dcLangMatch) {
    embeddedLang = normalizeLangCode(dcLangMatch[1]);
  }

  // Check for DC:title and DC:creator in EPUB/XMP metadata
  const dcTitleMatch = rawUtf8.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
  const dcCreatorMatch = rawUtf8.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
  if (dcTitleMatch) title = dcTitleMatch[1].trim();
  if (dcCreatorMatch) author = dcCreatorMatch[1].trim();

  // Check raw PDF Info dictionary keys (/Title, /Author, /Subject, /Keywords)
  const pdfTitleMatch = rawUtf8.match(/\/Title\s*\(([^)]+)\)/);
  const pdfAuthorMatch = rawUtf8.match(/\/Author\s*\(([^)]+)\)/);
  const pdfSubjectMatch = rawUtf8.match(/\/Subject\s*\(([^)]+)\)/);
  const pdfKeywordsMatch = rawUtf8.match(/\/Keywords\s*\(([^)]+)\)/);

  if (!title && pdfTitleMatch && pdfTitleMatch[1].trim()) {
    title = pdfTitleMatch[1].trim();
  }
  if (!author && pdfAuthorMatch && pdfAuthorMatch[1].trim()) {
    author = pdfAuthorMatch[1].trim();
  }
  if (pdfSubjectMatch) {
    bookmarksText += ' ' + pdfSubjectMatch[1];
  }
  if (pdfKeywordsMatch) {
    bookmarksText += ' ' + pdfKeywordsMatch[1];
  }

  // Extract PDF Outlines / Bookmarks titles if present
  const outlineMatches = rawUtf8.matchAll(/\/Title\s*\(([^)]{3,120})\)/g);
  for (const m of outlineMatches) {
    bookmarksText += ' ' + m[1];
  }

  // Check if PDF/EPUB has embedded raster image on page 1 or cover marker
  if (/\/Subtype\s*\/Image/i.test(rawLatin) || /cover\.(jpg|jpeg|png|webp)/i.test(rawLatin) || /HasCover:\s*true/i.test(rawUtf8)) {
    hasEmbeddedCover = true;
  }

  // If PDF, attempt pdf-parse for text extraction of pages 1-2
  if (file.format === 'pdf') {
    const origLog = console.log;
    const origWarn = console.warn;
    try {
      console.log = () => {};
      console.warn = () => {};
      const parsed = await pdfParse(buffer, { max: 2 });
      console.log = origLog;
      console.warn = origWarn;
      if (parsed?.info) {
        if (!title && parsed.info.Title && typeof parsed.info.Title === 'string') {
          title = parsed.info.Title.trim();
        }
        if (!author && parsed.info.Author && typeof parsed.info.Author === 'string') {
          author = parsed.info.Author.trim();
        }
        if (parsed.info.Subject) {
          bookmarksText += ' ' + String(parsed.info.Subject);
        }
        if (parsed.info.Keywords) {
          bookmarksText += ' ' + String(parsed.info.Keywords);
        }
      }
      if (parsed?.text && parsed.text.trim()) {
        first300Words = parsed.text
          .replace(/\s+/g, ' ')
          .trim()
          .split(' ')
          .slice(0, 300)
          .join(' ');
      }
    } catch {
      console.log = origLog;
      console.warn = origWarn;
      // Fallback to extracting readable text streams from raw buffer
    }
  }

  if (!first300Words) {
    // Extract readable text segments from rawUtf8 (e.g. text inside PDF parentheses or plain text blocks)
    const textChunks: string[] = [];
    const parenMatches = rawUtf8.matchAll(/\(([^()]{4,400})\)/g);
    for (const m of parenMatches) {
      if (!m[1].startsWith('D:') && !m[1].includes('/')) {
        textChunks.push(m[1]);
      }
    }
    const combined = (textChunks.join(' ') + ' ' + rawUtf8.replace(/[^\p{L}\p{N}\s.,;:-]/gu, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    first300Words = combined.split(' ').slice(0, 300).join(' ');
  }

  const isbn = extractIsbn(rawUtf8) || extractIsbn(first300Words);

  return {
    title,
    author,
    isbn,
    embeddedLang,
    bookmarksText: bookmarksText.trim(),
    first300Words,
    hasEmbeddedCover,
  };
}

/**
 * Module A: Groups sibling formats in the same directory sharing the exact same base name
 * or SHA-256 fingerprint under a single canonical book record, and inspects metadata.
 */
export async function aggregateAndInspectDirectory(
  dirPath: string,
  onDuplicateDetected?: (sha256: string, primaryPath: string, duplicatePath: string, sizeBytes: number) => void
): Promise<ExtractedBookMetadata[]> {
  const allFiles = walkDirectoryForBooks(dirPath);

  // Track SHA-256 across all folders to detect duplicates regardless of filename
  const seenHashes = new Map<string, ScannedFileInfo>();
  const uniqueFiles: ScannedFileInfo[] = [];

  for (const file of allFiles) {
    const existing = seenHashes.get(file.sha256);
    if (existing && existing.filePath !== file.filePath) {
      if (onDuplicateDetected) {
        onDuplicateDetected(file.sha256, existing.filePath, file.filePath, file.sizeBytes);
      }
      // If it's in a different directory or has a different base name, it's a duplicate copy
      if (existing.dirPath !== file.dirPath || existing.normalizedBase !== file.normalizedBase) {
        continue;
      }
    } else {
      seenHashes.set(file.sha256, file);
    }
    uniqueFiles.push(file);
  }

  // Group sibling files in the same directory sharing the exact same base name (e.g. principles_chem.pdf & principles_chem.epub)
  const siblingGroups = new Map<string, ScannedFileInfo[]>();
  for (const file of uniqueFiles) {
    const groupKey = `${path.resolve(file.dirPath)}::${file.normalizedBase}`;
    const list = siblingGroups.get(groupKey) || [];
    list.push(file);
    siblingGroups.set(groupKey, list);
  }

  const formatPriority: Record<string, number> = {
    pdf: 1,
    epub: 2,
    djvu: 3,
    mobi: 4,
  };

  const results: ExtractedBookMetadata[] = [];

  for (const groupFiles of siblingGroups.values()) {
    // Sort so PDF is the primary file if available
    groupFiles.sort((a, b) => (formatPriority[a.format] || 99) - (formatPriority[b.format] || 99));

    const primaryFile = groupFiles[0];
    const inspected = await inspectSingleFile(primaryFile);

    // Also inspect sibling files if primary lacked metadata
    for (let i = 1; i < groupFiles.length; i++) {
      const sibInfo = await inspectSingleFile(groupFiles[i]);
      if (!inspected.title && sibInfo.title) inspected.title = sibInfo.title;
      if (!inspected.author && sibInfo.author) inspected.author = sibInfo.author;
      if (!inspected.isbn && sibInfo.isbn) inspected.isbn = sibInfo.isbn;
      if (!inspected.embeddedLang && sibInfo.embeddedLang) inspected.embeddedLang = sibInfo.embeddedLang;
      if (!inspected.hasEmbeddedCover && sibInfo.hasEmbeddedCover) inspected.hasEmbeddedCover = true;
    }

    const fallbackParsed = parseTitleAndAuthorFromFilename(primaryFile.baseName);
    const finalTitle = inspected.title || fallbackParsed.title;
    const finalAuthor = inspected.author || fallbackParsed.author;

    const language = inspected.embeddedLang || detectLanguageFromText(`${finalTitle} ${inspected.first300Words}`);
    const languageSource = inspected.embeddedLang ? 'metadata' : 'ngram-300w';

    // Strictly formats physically detected on disk
    const localFormats = Array.from(new Set(groupFiles.map((f) => f.format.toLowerCase())));

    results.push({
      canonicalId: primaryFile.sha256,
      title: finalTitle,
      author: finalAuthor,
      isbn: inspected.isbn,
      language,
      languageSource,
      bookmarksText: inspected.bookmarksText,
      first300Words: inspected.first300Words,
      hasEmbeddedCover: inspected.hasEmbeddedCover,
      files: groupFiles,
      formats: localFormats,
    });
  }

  return results;
}
