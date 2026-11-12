# BookShelf (`booktrack`) — Local PDF Library Organizer & Tracker

A local-first PDF and eBook library CLI and interactive web dashboard that recursively scans folders, inspects embedded metadata, aggregates sibling formats, detects languages and translation variants, extracts or permission-gates cover thumbnails, categorizes books into a two-tier taxonomy, and atomically organizes files on disk with a reversible undo journal.

---

## Key Features & Operational Guarantees

1. **Strict Local-Hardware Format Detection**
   - Recognizes only file formats that physically exist on disk (`.pdf`, `.epub`, `.mobi`, `.djvu`).
   - **Sibling Format Aggregation:** Automatically groups files in the same directory sharing the same base name (e.g., `principles_chem.pdf` + `principles_chem.epub`) into a single canonical book record.
   - Never queries the internet to fabricate alternative format badges.

2. **Language & Translation Variant Detection**
   - Inspects embedded document metadata (`/Lang` PDF tags and `dc:language` EPUB/XMP headers).
   - Falls back to local n-gram and script detection on the first 300 words of pages 1–2 (`EN`, `FR`, `AR`, `ES`, `DE`, `RU`, `ZH`, `IT`, `PT`).
   - Automatically flags **Translation Variants** when multiple language editions exist locally sharing the same ISBN or canonical title.

3. **Local Cover Extraction & Permission-Gated Cover Fetcher**
   - Extracts embedded cover images or renders a local page-1 visual thumbnail into `.cache/covers/[sha256].webp`.
   - When a book lacks an embedded visual cover, locates a candidate public cover URL (via Open Library / Google Books APIs) and **requires explicit user approval** in the CLI (`[y/N / Enter custom URL]`) or Web Dashboard modal before downloading anything.

4. **Two-Tier Categorization Engine (`Category` -> `Subcategory`)**
   - Evaluates custom regex rules in [`rules.json`](./rules.json) first (e.g., `title =~ /thermodynamics/i -> Physics/Thermodynamics`).
   - Scans internal PDF bookmarks, Table of Contents, and title keywords against [`taxonomy.json`](./taxonomy.json).
   - Supports interactive CLI fallback prompts (`--interactive`) and one-click UI recategorization.

5. **Atomic File Relocation & Undo Journal (`booktrack undo`)**
   - Organizes files into `<DESTINATION_ROOT>/<Category>/<Subcategory>/[Cleaned_Title] - [Author].[ext]` using collision-safe atomic moves.
   - Logs every file relocation in an SQLite `undo_log` table so any batch move can be reversed in a single command.
   - Flags duplicate files across folders using SHA-256 checksums regardless of filename differences.

6. **Multi-Theme Interactive Web Dashboard (`http://127.0.0.1:4080`)**
   - Built-in theme engine supporting **Dark**, **Light**, **Sepia**, **Cyberpunk / OLED**, **Slate**, **Emerald**, **High Contrast**, and **System Auto**.
   - Live category tree sidebar matching the physical disk hierarchy, format/language filters, dry-run preview table, permission-gated cover modal, SHA-256 duplicates view, live `rules.json` / `taxonomy.json` editor, and 1-click sample library generator.

---

## Quick Start for New Users

### Prerequisites
- **Node.js** v18+ (tested on Node.js v20 LTS)
- **npm** v9+

### 1. Install & Build
```bash
cd BookShelf
npm install
npm run build
```

*(Optional)* Link the `booktrack` binary globally on your machine:
```bash
npm link
```

### 2. Try It Immediately with Sample Books
You can generate a realistic set of multi-format sample books (`.pdf`, `.epub`, `.mobi`, `.djvu`, multi-language editions in `EN`/`FR`/`AR`, and duplicate files) with one command:

```bash
npm run demo
```

### 3. Run the Automated Test Suite
```bash
npm test
```

---

## CLI Command Reference (`booktrack`)

You can run commands via `npx booktrack <command>` (or `node dist/cli.js <command>`):

```bash
# 1. Initialize database and set default destination library directory
node dist/cli.js init --library-dir ./sample-library

# 2. Dry-Run Scan (preview proposed categories, formats, and moves without touching files)
node dist/cli.js scan ./sample-downloads --dest ./sample-library --dry-run

# 3. Interactive Scan & Organize (prompts for missing cover approvals & uncertain categories)
node dist/cli.js scan ./sample-downloads --dest ./sample-library --interactive

# 4. Non-Interactive Scan & Organize + Clean up empty source directories
node dist/cli.js scan ./sample-downloads --dest ./sample-library --clean-empty

# 5. List all indexed books in the local SQLite database
node dist/cli.js list
node dist/cli.js list --category Chemistry --format pdf

# 6. Undo the last batch of file relocations atomically
node dist/cli.js undo

# 7. Launch the Interactive Web Dashboard on http://127.0.0.1:4080
node dist/cli.js ui --port 4080
```

---

## Interactive Web Dashboard (`http://127.0.0.1:4080`)

Start the dashboard server with:
```bash
npm start
```
Then open **`http://127.0.0.1:4080`** in your browser:
- **+ Generate Sample Books**: Creates sample PDF, EPUB, MOBI, and DJVU files in `sample-downloads/` so you can test the workflow in one click.
- **Dry-Run Mode Toggle**: Preview every proposed `Category / Subcategory` assignment and destination file path before moving any files.
- **Approve Cover Download**: Click on any book with a pending cover URL to inspect, customize, or approve/decline the cover download.
- **Inspect / Move**: View all aggregated sibling format paths, SHA-256 checksums, and relocate a book to a new category on disk.
- **Rules & Taxonomy Engine**: Edit `rules.json` and `taxonomy.json` directly from the browser.

---

## Customizing Categorization (`rules.json` & `taxonomy.json`)

### `rules.json`
Define regex rules using the format `<field> =~ /<pattern>/<flags> -> <Category>/<Subcategory>`, where `<field>` can be `title`, `author`, `bookmarks`, `text`, or `any`:
```json
{
  "rules": [
    "title =~ /thermodynamics|entropy/i -> Physics/Thermodynamics",
    "title =~ /organic chemistry|stereochemistry/i -> Chemistry/Organic Chemistry"
  ]
}
```

### `taxonomy.json`
Define two-tier categories and keyword arrays matched against PDF titles, bookmarks/outlines, and opening text:
```json
{
  "Chemistry": {
    "Organic Chemistry": ["organic chemistry", "hydrocarbons", "stereochemistry", "synthesis"],
    "Inorganic & Physical Chemistry": ["inorganic chemistry", "physical chemistry", "electrochemistry"]
  }
}
```

---

## Project Architecture

```text
BookShelf/
├── src/
│   ├── cli.ts          # Commander.js CLI entrypoint (init, scan, undo, ui, list, demo)
│   ├── db.ts           # Embedded SQLite database layer & schema migrations
│   ├── scanner.ts      # Recursive scanner, sibling aggregator, metadata & n-gram language detector
│   ├── covers.ts       # Local page-1 cover renderer & permission-gated cover URL fetcher
│   ├── categorizer.ts  # Regex rules engine, taxonomy matcher & collision-safe atomic file mover
│   ├── undo.ts         # Atomic journal batch reversal engine
│   ├── server.ts       # Local Express REST API & static dashboard host (127.0.0.1:4080)
│   ├── demo.ts         # Sample multi-format book generator for quick testing
│   └── test.ts         # End-to-end automated integration test suite
├── public/
│   ├── index.html      # Interactive Web Dashboard SPA
│   ├── styles.css      # Multi-theme CSS variable tokens (Dark, Light, Sepia, Cyberpunk, Slate, Emerald, High Contrast)
│   └── app.js          # Frontend state, category browser, cover modal & dry-run inspector
├── taxonomy.json       # Two-tier Category -> Subcategory keyword map
├── rules.json          # Automated regex categorization rules
├── package.json
└── tsconfig.json
```

---

## License

MIT
