// BookShelf Interactive Dashboard Frontend Engine
(function () {
  let state = {
    books: [],
    categoryTree: {},
    duplicates: [],
    undoBatches: [],
    settings: { libraryDir: '', lastSourceDir: '', rootDir: '' },
    activeView: 'all', // 'all' | 'pending-covers' | 'translations' | 'duplicates' | 'undo-history' | 'rules-editor' | 'category'
    selectedCategory: null,
    selectedSubcategory: null,
    searchQuery: '',
    formatFilter: 'ALL',
    langFilter: 'ALL',
    activeCoverBook: null,
  };

  // DOM References
  const themeSelector = document.getElementById('themeSelector');
  const searchInput = document.getElementById('searchInput');
  const formatFilter = document.getElementById('formatFilter');
  const langFilter = document.getElementById('langFilter');
  const scanForm = document.getElementById('scanForm');
  const sourceDirInput = document.getElementById('sourceDirInput');
  const destDirInput = document.getElementById('destDirInput');
  const dryRunToggle = document.getElementById('dryRunToggle');
  const cleanEmptyToggle = document.getElementById('cleanEmptyToggle');
  const generateDemoBtn = document.getElementById('generateDemoBtn');
  const undoLastBtn = document.getElementById('undoLastBtn');

  const countAllBooks = document.getElementById('countAllBooks');
  const countPendingCovers = document.getElementById('countPendingCovers');
  const countTranslations = document.getElementById('countTranslations');
  const countDuplicates = document.getElementById('countDuplicates');
  const countUndoBatches = document.getElementById('countUndoBatches');

  const categoryTreeContainer = document.getElementById('categoryTreeContainer');
  const booksGrid = document.getElementById('booksGrid');
  const auxiliaryViewContainer = document.getElementById('auxiliaryViewContainer');
  const activeViewTitle = document.getElementById('activeViewTitle');
  const activeViewSubtitle = document.getElementById('activeViewSubtitle');

  const statusBanner = document.getElementById('statusBanner');
  const statusBannerText = document.getElementById('statusBannerText');
  const closeBannerBtn = document.getElementById('closeBannerBtn');

  const dryRunPanel = document.getElementById('dryRunPanel');
  const dryRunTableContainer = document.getElementById('dryRunTableContainer');
  const closeDryRunBtn = document.getElementById('closeDryRunBtn');

  const coverModal = document.getElementById('coverModal');
  const coverModalBookTitle = document.getElementById('coverModalBookTitle');
  const coverModalPromptText = document.getElementById('coverModalPromptText');
  const coverModalUrlInput = document.getElementById('coverModalUrlInput');
  const closeCoverModalBtn = document.getElementById('closeCoverModalBtn');
  const approveCoverBtn = document.getElementById('approveCoverBtn');
  const rejectCoverBtn = document.getElementById('rejectCoverBtn');

  const inspectModal = document.getElementById('inspectModal');
  const inspectModalTitle = document.getElementById('inspectModalTitle');
  const inspectModalContent = document.getElementById('inspectModalContent');
  const closeInspectModalBtn = document.getElementById('closeInspectModalBtn');

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function showNotification(msg) {
    statusBannerText.textContent = msg;
    statusBanner.classList.remove('hidden');
  }

  closeBannerBtn.addEventListener('click', () => {
    statusBanner.classList.add('hidden');
  });

  closeDryRunBtn.addEventListener('click', () => {
    dryRunPanel.classList.add('hidden');
  });

  // Theme Initialization
  function applyTheme(themeVal) {
    localStorage.setItem('bookshelf_theme', themeVal);
    if (themeVal === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', themeVal);
    }
  }

  const savedTheme = localStorage.getItem('bookshelf_theme') || 'dark';
  themeSelector.value = savedTheme;
  applyTheme(savedTheme);
  themeSelector.addEventListener('change', (e) => applyTheme(e.target.value));

  // Fetch Full State from Server
  async function loadLibraryState() {
    try {
      const res = await fetch('/api/state');
      const data = await res.json();
      state.books = data.books || [];
      state.categoryTree = data.categoryTree || {};
      state.duplicates = data.duplicates || [];
      state.undoBatches = data.undoBatches || [];
      state.settings = data.settings || {};

      if (!sourceDirInput.value && state.settings.lastSourceDir) {
        sourceDirInput.value = state.settings.lastSourceDir;
      }
      if (!destDirInput.value && state.settings.libraryDir) {
        destDirInput.value = state.settings.libraryDir;
      }

      renderSidebar();
      renderMainContent();
    } catch (err) {
      showNotification('Failed to load library state: ' + err.message);
    }
  }

  // Render Sidebar Counts & Category Hierarchy
  function renderSidebar() {
    countAllBooks.textContent = state.books.length;
    countPendingCovers.textContent = state.books.filter((b) => b.has_cover_url_pending).length;
    countTranslations.textContent = state.books.filter((b) => b.is_translation_variant === 1).length;
    countDuplicates.textContent = state.duplicates.length;
    countUndoBatches.textContent = state.undoBatches.filter((u) => u.reverted === 0).length;

    // Highlight active special view button
    document.querySelectorAll('#specialViewsNav button').forEach((btn) => {
      const v = btn.getAttribute('data-view');
      if (state.activeView === v) {
        btn.classList.add('sidebar-item-active');
      } else {
        btn.classList.remove('sidebar-item-active');
      }
    });

    // Render Category -> Subcategory hierarchy
    const categories = Object.keys(state.categoryTree).sort();
    if (categories.length === 0) {
      categoryTreeContainer.innerHTML = `<div class="p-3 rounded-lg app-input text-center" style="color: var(--text-muted)">No categories on disk yet. Click <b>+ Generate Sample Books</b> then <b>Scan &amp; Organize</b>!</div>`;
      return;
    }

    categoryTreeContainer.innerHTML = categories
      .map((cat) => {
        const catInfo = state.categoryTree[cat];
        const isCatActive =
          state.activeView === 'category' && state.selectedCategory === cat && !state.selectedSubcategory;
        const subs = Object.keys(catInfo.subcategories).sort();

        const subsHtml = subs
          .map((sub) => {
            const subCount = catInfo.subcategories[sub];
            const isSubActive =
              state.activeView === 'category' &&
              state.selectedCategory === cat &&
              state.selectedSubcategory === sub;
            return `
              <button
                data-cat="${escapeHtml(cat)}"
                data-sub="${escapeHtml(sub)}"
                class="w-full flex items-center justify-between pl-6 pr-3 py-1.5 rounded-lg text-left cursor-pointer ${
                  isSubActive ? 'sidebar-item-active' : ''
                }"
              >
                <span class="truncate">↳ ${escapeHtml(sub)}</span>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-mono app-input">${subCount}</span>
              </button>
            `;
          })
          .join('');

        return `
          <div class="space-y-1">
            <button
              data-cat="${escapeHtml(cat)}"
              class="w-full flex items-center justify-between px-3 py-1.5 rounded-lg font-semibold text-left cursor-pointer ${
                isCatActive ? 'sidebar-item-active' : ''
              }"
            >
              <span class="truncate">📁 ${escapeHtml(cat)}</span>
              <span class="px-2 py-0.5 rounded-full text-[11px] font-mono app-input">${catInfo.count}</span>
            </button>
            <div class="space-y-0.5">${subsHtml}</div>
          </div>
        `;
      })
      .join('');

    // Attach listeners to category & subcategory buttons
    categoryTreeContainer.querySelectorAll('button[data-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeView = 'category';
        state.selectedCategory = btn.getAttribute('data-cat');
        state.selectedSubcategory = btn.getAttribute('data-sub') || null;
        renderSidebar();
        renderMainContent();
      });
    });
  }

  // Special Views Navigation
  document.querySelectorAll('#specialViewsNav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeView = btn.getAttribute('data-view');
      state.selectedCategory = null;
      state.selectedSubcategory = null;
      renderSidebar();
      renderMainContent();
    });
  });

  // Search & Filter Listeners
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim().toLowerCase();
    renderMainContent();
  });

  formatFilter.addEventListener('change', (e) => {
    state.formatFilter = e.target.value;
    renderMainContent();
  });

  langFilter.addEventListener('change', (e) => {
    state.langFilter = e.target.value;
    renderMainContent();
  });

  // Format Badge Helper (Strictly Local Formats)
  function renderFormatBadges(formats) {
    const colorMap = {
      pdf: 'background: rgba(239, 68, 68, 0.16); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4);',
      epub: 'background: rgba(16, 185, 129, 0.16); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4);',
      mobi: 'background: rgba(245, 158, 11, 0.16); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4);',
      djvu: 'background: rgba(168, 85, 247, 0.16); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4);',
    };
    return (formats || [])
      .map((fmt) => {
        const style = colorMap[fmt.toLowerCase()] || '';
        return `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase" style="${style}">${escapeHtml(
          fmt
        )}</span>`;
      })
      .join('');
  }

  // Main Content Renderer
  function renderMainContent() {
    if (state.activeView === 'duplicates') {
      booksGrid.classList.add('hidden');
      auxiliaryViewContainer.classList.remove('hidden');
      activeViewTitle.textContent = 'SHA-256 Duplicate File Detector';
      activeViewSubtitle.textContent =
        'Identical file checksums detected across folders regardless of filename differences';
      renderDuplicatesView();
      return;
    }

    if (state.activeView === 'undo-history') {
      booksGrid.classList.add('hidden');
      auxiliaryViewContainer.classList.remove('hidden');
      activeViewTitle.textContent = 'Atomic Undo Journal';
      activeViewSubtitle.textContent =
        'Every batch of physical file relocations is journaled and can be reversed atomically';
      renderUndoHistoryView();
      return;
    }

    if (state.activeView === 'rules-editor') {
      booksGrid.classList.add('hidden');
      auxiliaryViewContainer.classList.remove('hidden');
      activeViewTitle.textContent = 'Custom Category Rules & Taxonomy Engine';
      activeViewSubtitle.textContent =
        'Configure regex rules (rules.json) and two-tier classification keywords (taxonomy.json)';
      renderRulesEditorView();
      return;
    }

    booksGrid.classList.remove('hidden');
    auxiliaryViewContainer.classList.add('hidden');

    // Filter books
    let filtered = state.books.slice();

    if (state.activeView === 'pending-covers') {
      activeViewTitle.textContent = 'Pending Cover Approvals';
      activeViewSubtitle.textContent =
        'Books without embedded local covers awaiting explicit user permission before web download';
      filtered = filtered.filter((b) => Boolean(b.has_cover_url_pending));
    } else if (state.activeView === 'translations') {
      activeViewTitle.textContent = 'Translation Variants & Multi-Language Editions';
      activeViewSubtitle.textContent =
        'Books sharing the same ISBN or canonical title across different languages (EN, FR, AR, etc.)';
      filtered = filtered.filter((b) => b.is_translation_variant === 1);
    } else if (state.activeView === 'category') {
      activeViewTitle.textContent = state.selectedSubcategory
        ? `${state.selectedCategory} / ${state.selectedSubcategory}`
        : state.selectedCategory;
      activeViewSubtitle.textContent = 'Matching physical folder hierarchy on local disk';
      filtered = filtered.filter((b) => {
        if (b.category !== state.selectedCategory) return false;
        if (state.selectedSubcategory && b.subcategory !== state.selectedSubcategory) return false;
        return true;
      });
    } else {
      activeViewTitle.textContent = 'All Local Books';
      activeViewSubtitle.textContent = `${state.books.length} canonical book records indexed strictly from local hardware`;
    }

    if (state.formatFilter !== 'ALL') {
      filtered = filtered.filter((b) => (b.formats || []).includes(state.formatFilter));
    }

    if (state.langFilter !== 'ALL') {
      filtered = filtered.filter((b) => (b.language || 'EN').toUpperCase() === state.langFilter);
    }

    if (state.searchQuery) {
      const q = state.searchQuery;
      filtered = filtered.filter((b) => {
        const hay = `${b.title} ${b.author || ''} ${b.isbn || ''} ${b.category} ${b.subcategory || ''} ${(
          b.formats || []
        ).join(' ')}`.toLowerCase();
        return hay.includes(q);
      });
    }

    if (filtered.length === 0) {
      booksGrid.innerHTML = `
        <div class="col-span-full app-card rounded-2xl p-10 text-center space-y-3">
          <div class="text-lg font-bold">No matching books found</div>
          <p class="text-xs max-w-md mx-auto" style="color: var(--text-secondary)">
            Click <b>+ Generate Sample Books</b> in the top bar and then press <b>Scan &amp; Organize</b> to populate a full sample library with PDFs, EPUBs, MOBIs, translations, and covers!
          </p>
        </div>
      `;
      return;
    }

    booksGrid.innerHTML = filtered
      .map((book) => {
        const primaryPath = book.files && book.files[0] ? book.files[0].file_path : 'Unknown path';
        const totalSize = (book.files || []).reduce((acc, f) => acc + (f.file_size_bytes || 0), 0);

        const coverHtml = book.cover_path
          ? `<img src="${escapeHtml(book.cover_path)}" alt="${escapeHtml(
              book.title
            )}" class="w-full h-56 object-cover rounded-t-xl border-b" style="border-color: var(--border-color)" />`
          : `
            <div class="w-full h-56 rounded-t-xl border-b flex flex-col items-center justify-center p-4 text-center relative" style="background: var(--bg-elevated); border-color: var(--border-color)">
              <div class="text-xs font-mono uppercase px-2 py-0.5 rounded badge-accent mb-2">No Embedded Cover</div>
              <div class="font-bold text-sm line-clamp-2">${escapeHtml(book.title)}</div>
              <div class="text-xs mt-1" style="color: var(--text-secondary)">${escapeHtml(
                book.author || 'Unknown Author'
              )}</div>
              ${
                book.has_cover_url_pending
                  ? `<button data-approve-cover="${escapeHtml(
                      book.id
                    )}" class="mt-3 btn-accent px-3 py-1.5 rounded-lg text-[11px] font-bold cursor-pointer shadow">
                      Approve Cover Download
                    </button>`
                  : ''
              }
            </div>
          `;

        return `
          <article class="app-card rounded-xl flex flex-col justify-between overflow-hidden">
            <div>
              ${coverHtml}
              <div class="p-4 space-y-2.5">
                <div class="flex items-center justify-between gap-1.5 flex-wrap">
                  <div class="flex items-center gap-1 flex-wrap">
                    ${renderFormatBadges(book.formats)}
                  </div>
                  <div class="flex items-center gap-1">
                    <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold app-input" title="Detected Language">
                      🌐 ${escapeHtml(book.language || 'EN')}
                    </span>
                    ${
                      book.is_translation_variant
                        ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono badge-accent" title="Multiple language editions detected locally">TRANSLATION</span>`
                        : ''
                    }
                  </div>
                </div>

                <div>
                  <h3 class="font-bold text-sm leading-snug line-clamp-2" title="${escapeHtml(book.title)}">
                    ${escapeHtml(book.title)}
                  </h3>
                  <p class="text-xs mt-0.5" style="color: var(--text-secondary)">
                    ${escapeHtml(book.author || 'Unknown Author')}
                    ${book.isbn ? `<span class="font-mono text-[10px] opacity-75"> • ISBN ${escapeHtml(book.isbn)}</span>` : ''}
                  </p>
                </div>

                <div class="text-[11px] font-medium px-2.5 py-1 rounded-lg app-input flex items-center justify-between">
                  <span class="truncate">📂 ${escapeHtml(book.category)} / ${escapeHtml(
          book.subcategory || 'General'
        )}</span>
                  <span class="font-mono text-[10px] shrink-0 ml-2" style="color: var(--text-muted)">${formatBytes(
                    totalSize
                  )}</span>
                </div>
              </div>
            </div>

            <div class="px-4 pb-3 pt-2 border-t flex items-center justify-between gap-2 text-[11px]" style="border-color: var(--border-color)">
              <div class="truncate font-mono text-[10px]" style="color: var(--text-muted)" title="${escapeHtml(
                primaryPath
              )}">
                ${escapeHtml(primaryPath)}
              </div>
              <button
                data-inspect-book="${escapeHtml(book.id)}"
                class="btn-secondary px-2.5 py-1 rounded text-[11px] font-medium shrink-0 cursor-pointer"
              >
                Inspect / Move
              </button>
            </div>
          </article>
        `;
      })
      .join('');

    // Wire up Cover Approval buttons
    booksGrid.querySelectorAll('button[data-approve-cover]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-approve-cover');
        const book = state.books.find((b) => b.id === id);
        if (book) openCoverModal(book);
      });
    });

    // Wire up Book Inspect / Move buttons
    booksGrid.querySelectorAll('button[data-inspect-book]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-inspect-book');
        const book = state.books.find((b) => b.id === id);
        if (book) openInspectModal(book);
      });
    });
  }

  // Permission-Gated Cover Approval Modal
  function openCoverModal(book) {
    state.activeCoverBook = book;
    coverModalBookTitle.textContent = `Cover Missing for "${book.title}"`;
    coverModalPromptText.textContent = `Cover missing for "${book.title}". Candidate cover URL: ${book.has_cover_url_pending}. Download cover? [y/N / Enter custom URL]:`;
    coverModalUrlInput.value = book.has_cover_url_pending || '';
    coverModal.classList.remove('hidden');
    coverModal.classList.add('flex');
  }

  function closeCoverModal() {
    coverModal.classList.add('hidden');
    coverModal.classList.remove('flex');
    state.activeCoverBook = null;
  }

  closeCoverModalBtn.addEventListener('click', closeCoverModal);

  approveCoverBtn.addEventListener('click', async () => {
    if (!state.activeCoverBook) return;
    const bookId = state.activeCoverBook.id;
    const customUrl = coverModalUrlInput.value.trim();
    approveCoverBtn.disabled = true;
    approveCoverBtn.textContent = 'Downloading...';

    try {
      const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/approve-cover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', customUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to download cover');
      closeCoverModal();
      showNotification(`Approved and cached cover for "${state.books.find((b) => b.id === bookId)?.title}".`);
      await loadLibraryState();
    } catch (err) {
      showNotification('Error approving cover: ' + err.message);
    } finally {
      approveCoverBtn.disabled = false;
      approveCoverBtn.textContent = 'Approve & Download Cover (y)';
    }
  });

  rejectCoverBtn.addEventListener('click', async () => {
    if (!state.activeCoverBook) return;
    const bookId = state.activeCoverBook.id;
    try {
      await fetch(`/api/books/${encodeURIComponent(bookId)}/approve-cover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject' }),
      });
      closeCoverModal();
      showNotification('Cover candidate URL dismissed.');
      await loadLibraryState();
    } catch (err) {
      showNotification('Error dismissing cover: ' + err.message);
    }
  });

  // Inspect & Recategorize Book Modal
  function openInspectModal(book) {
    inspectModalTitle.textContent = book.title;
    const filesHtml = (book.files || [])
      .map(
        (f) => `
        <div class="p-2.5 rounded-lg app-input space-y-1">
          <div class="flex items-center justify-between">
            <span class="font-bold uppercase font-mono text-[11px]">${escapeHtml(f.format)}</span>
            <span class="font-mono text-[10px]" style="color: var(--text-muted)">${formatBytes(
              f.file_size_bytes
            )} • SHA-256: ${escapeHtml((f.sha256 || '').slice(0, 12))}...</span>
          </div>
          <div class="font-mono text-[11px] break-all select-all">${escapeHtml(f.file_path)}</div>
        </div>
      `
      )
      .join('');

    inspectModalContent.innerHTML = `
      <div class="grid grid-cols-2 gap-3 p-3 rounded-lg app-input">
        <div><span style="color: var(--text-muted)">Author:</span> <b>${escapeHtml(
          book.author || 'Unknown'
        )}</b></div>
        <div><span style="color: var(--text-muted)">ISBN:</span> <b class="font-mono">${escapeHtml(
          book.isbn || 'N/A'
        )}</b></div>
        <div><span style="color: var(--text-muted)">Language:</span> <b>${escapeHtml(
          book.language || 'EN'
        )}</b></div>
        <div><span style="color: var(--text-muted)">Canonical SHA-256:</span> <b class="font-mono">${escapeHtml(
          book.id.slice(0, 14)
        )}…</b></div>
      </div>

      <div class="space-y-1.5">
        <div class="font-semibold">Local Sibling Files on Hardware (${(book.files || []).length}):</div>
        ${filesHtml}
      </div>

      <form id="recategorizeForm" class="space-y-3 pt-3 border-t" style="border-color: var(--border-color)">
        <div class="font-semibold">Atomic File Relocation (Update Category / Subcategory):</div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[11px] mb-1" style="color: var(--text-secondary)">Category</label>
            <input id="recatCategory" type="text" value="${escapeHtml(
              book.category
            )}" class="app-input w-full rounded-lg px-3 py-1.5 text-xs" required />
          </div>
          <div>
            <label class="block text-[11px] mb-1" style="color: var(--text-secondary)">Subcategory</label>
            <input id="recatSubcategory" type="text" value="${escapeHtml(
              book.subcategory || 'General'
            )}" class="app-input w-full rounded-lg px-3 py-1.5 text-xs" required />
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button type="submit" class="btn-accent px-4 py-2 rounded-lg text-xs font-bold cursor-pointer">
            Relocate Files on Disk
          </button>
        </div>
      </form>
    `;

    inspectModal.classList.remove('hidden');
    inspectModal.classList.add('flex');

    const recatForm = document.getElementById('recategorizeForm');
    recatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const category = document.getElementById('recatCategory').value.trim();
      const subcategory = document.getElementById('recatSubcategory').value.trim();
      try {
        const res = await fetch(`/api/books/${encodeURIComponent(book.id)}/recategorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category, subcategory }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Recategorization failed');
        inspectModal.classList.add('hidden');
        inspectModal.classList.remove('flex');
        showNotification(`Atomically relocated "${book.title}" to ${category}/${subcategory}.`);
        await loadLibraryState();
      } catch (err) {
        showNotification('Failed to relocate book: ' + err.message);
      }
    });
  }

  closeInspectModalBtn.addEventListener('click', () => {
    inspectModal.classList.add('hidden');
    inspectModal.classList.remove('flex');
  });

  // Render Duplicates View
  function renderDuplicatesView() {
    if (state.duplicates.length === 0) {
      auxiliaryViewContainer.innerHTML = `
        <div class="app-card rounded-xl p-8 text-center text-xs" style="color: var(--text-secondary)">
          No duplicate files detected across scanned directories.
        </div>
      `;
      return;
    }

    const rows = state.duplicates
      .map(
        (d) => `
        <tr class="border-b" style="border-color: var(--border-color)">
          <td class="py-2.5 px-3 font-mono text-[11px]">${escapeHtml(d.sha256.slice(0, 16))}…</td>
          <td class="py-2.5 px-3 font-mono text-[11px] break-all">${escapeHtml(d.primary_path)}</td>
          <td class="py-2.5 px-3 font-mono text-[11px] break-all">${escapeHtml(d.duplicate_path)}</td>
          <td class="py-2.5 px-3 font-mono text-[11px]">${formatBytes(d.file_size_bytes)}</td>
        </tr>
      `
      )
      .join('');

    auxiliaryViewContainer.innerHTML = `
      <div class="app-card rounded-xl overflow-hidden">
        <table class="w-full text-left text-xs">
          <thead class="app-surface border-b" style="border-color: var(--border-color)">
            <tr>
              <th class="py-3 px-3">SHA-256 Checksum</th>
              <th class="py-3 px-3">Primary File Path</th>
              <th class="py-3 px-3">Duplicate Copy Path</th>
              <th class="py-3 px-3">Size</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // Render Atomic Undo Journal View
  function renderUndoHistoryView() {
    if (state.undoBatches.length === 0) {
      auxiliaryViewContainer.innerHTML = `
        <div class="app-card rounded-xl p-8 text-center text-xs" style="color: var(--text-secondary)">
          No file relocation batches recorded yet.
        </div>
      `;
      return;
    }

    auxiliaryViewContainer.innerHTML = state.undoBatches
      .map((batch) => {
        const entryRows = (batch.entries || [])
          .map(
            (e) => `
            <div class="text-[11px] font-mono p-2 rounded app-input flex flex-col gap-0.5">
              <div><span style="color: var(--text-muted)">FROM:</span> ${escapeHtml(e.old_path)}</div>
              <div><span style="color: var(--accent)">  TO:</span> ${escapeHtml(e.new_path)}</div>
            </div>
          `
          )
          .join('');

        return `
          <div class="app-card rounded-xl p-5 mb-4 space-y-3">
            <div class="flex items-center justify-between">
              <div>
                <span class="font-mono text-xs font-bold">${escapeHtml(batch.batch_id)}</span>
                <span class="text-xs ml-2" style="color: var(--text-secondary)">• ${
                  batch.move_count
                } file(s) moved at ${escapeHtml(batch.created_at)}</span>
              </div>
              <div>
                ${
                  batch.reverted
                    ? `<span class="px-2.5 py-1 rounded text-xs font-mono app-input">REVERTED</span>`
                    : `<button data-undo-batch="${escapeHtml(
                        batch.batch_id
                      )}" class="btn-accent px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer">Revert This Batch</button>`
                }
              </div>
            </div>
            <div class="space-y-1.5 max-h-56 overflow-y-auto">${entryRows}</div>
          </div>
        `;
      })
      .join('');

    auxiliaryViewContainer.querySelectorAll('button[data-undo-batch]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const batchId = btn.getAttribute('data-undo-batch');
        await triggerUndo(batchId);
      });
    });
  }

  // Render Rules & Taxonomy Editor View
  async function renderRulesEditorView() {
    auxiliaryViewContainer.innerHTML = `<div class="text-xs">Loading rules.json and taxonomy.json...</div>`;
    try {
      const res = await fetch('/api/rules-taxonomy');
      const data = await res.json();

      auxiliaryViewContainer.innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="app-card rounded-xl p-5 space-y-3">
            <h3 class="font-bold text-sm">Custom Regex Rules Engine (<code>rules.json</code>)</h3>
            <p class="text-xs" style="color: var(--text-secondary)">
              One rule per line: <code>title =~ /thermodynamics/i -&gt; Physics/Thermodynamics</code>
            </p>
            <textarea id="rulesTextarea" rows="14" class="app-input w-full rounded-lg p-3 font-mono text-xs">${escapeHtml(
              (data.rules || []).join('\n')
            )}</textarea>
          </div>

          <div class="app-card rounded-xl p-5 space-y-3">
            <h3 class="font-bold text-sm">Two-Tier Classification Map (<code>taxonomy.json</code>)</h3>
            <p class="text-xs" style="color: var(--text-secondary)">
              JSON mapping of <code>Category -&gt; Subcategory -&gt; [keywords]</code>
            </p>
            <textarea id="taxonomyTextarea" rows="14" class="app-input w-full rounded-lg p-3 font-mono text-xs">${escapeHtml(
              JSON.stringify(data.taxonomy || {}, null, 2)
            )}</textarea>
          </div>
        </div>
        <div class="mt-4 flex justify-end">
          <button id="saveRulesTaxonomyBtn" class="btn-accent px-5 py-2.5 rounded-lg text-xs font-bold cursor-pointer">
            Save Rules &amp; Taxonomy Configuration
          </button>
        </div>
      `;

      document.getElementById('saveRulesTaxonomyBtn').addEventListener('click', async () => {
        try {
          const rulesLines = document
            .getElementById('rulesTextarea')
            .value.split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          const parsedTax = JSON.parse(document.getElementById('taxonomyTextarea').value);
          const saveRes = await fetch('/api/rules-taxonomy', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rules: rulesLines, taxonomy: parsedTax }),
          });
          if (!saveRes.ok) throw new Error('Failed to save configuration');
          showNotification('Saved rules.json and taxonomy.json successfully!');
        } catch (err) {
          showNotification('Invalid JSON or save error: ' + err.message);
        }
      });
    } catch (err) {
      auxiliaryViewContainer.innerHTML = `<div class="text-xs text-red-400">Error loading config: ${escapeHtml(
        err.message
      )}</div>`;
    }
  }

  // Trigger Scan & Organize or Dry-Run
  scanForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sourceDir = sourceDirInput.value.trim();
    const destDir = destDirInput.value.trim();
    const dryRun = dryRunToggle.checked;
    const cleanEmpty = cleanEmptyToggle.checked;

    const btn = document.getElementById('scanSubmitBtn');
    btn.disabled = true;
    btn.textContent = dryRun ? 'Running Dry-Run...' : 'Scanning & Organizing...';

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceDir, destDir, dryRun, cleanEmpty }),
      });
      const report = await res.json();
      if (!res.ok) throw new Error(report.error || 'Scan failed');

      if (dryRun) {
        renderDryRunReport(report);
        showNotification(
          `Dry-Run completed: ${report.scannedBooks} book(s) inspected, ${report.duplicatesDetected} duplicate(s) flagged. No files were moved.`
        );
      } else {
        dryRunPanel.classList.add('hidden');
        showNotification(
          `Organized ${report.scannedBooks} book(s) (${report.movedFiles} file moves committed in batch ${
            report.batchId || 'N/A'
          }).`
        );
        await loadLibraryState();
      }
    } catch (err) {
      showNotification('Scan error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Scan & Organize';
    }
  });

  function renderDryRunReport(report) {
    dryRunPanel.classList.remove('hidden');
    const rows = (report.items || [])
      .map((item) => {
        const destPreview =
          item.plannedMoves && item.plannedMoves[0] ? item.plannedMoves[0].to : 'No files';
        return `
          <tr class="border-b" style="border-color: var(--border-color)">
            <td class="py-2 px-3 font-bold">${escapeHtml(item.title)}</td>
            <td class="py-2 px-3">${escapeHtml(item.author || 'Unknown')}</td>
            <td class="py-2 px-3">${renderFormatBadges(item.formats)}</td>
            <td class="py-2 px-3 font-mono">${escapeHtml(item.language)}</td>
            <td class="py-2 px-3">
              <span class="px-2 py-0.5 rounded badge-accent font-mono">${escapeHtml(
                item.category
              )} / ${escapeHtml(item.subcategory)}</span>
            </td>
            <td class="py-2 px-3 font-mono text-[11px] break-all">${escapeHtml(destPreview)}</td>
          </tr>
        `;
      })
      .join('');

    dryRunTableContainer.innerHTML = `
      <table class="w-full text-left">
        <thead class="app-surface border-b" style="border-color: var(--border-color)">
          <tr>
            <th class="py-2 px-3">Book Title</th>
            <th class="py-2 px-3">Author</th>
            <th class="py-2 px-3">Local Formats</th>
            <th class="py-2 px-3">Lang</th>
            <th class="py-2 px-3">Proposed Taxonomy</th>
            <th class="py-2 px-3">Destination Path Preview</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // Generate Sample Books Helper
  generateDemoBtn.addEventListener('click', async () => {
    generateDemoBtn.disabled = true;
    generateDemoBtn.textContent = 'Generating...';
    try {
      const res = await fetch('/api/demo', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate sample files');
      sourceDirInput.value = data.sourceDir;
      destDirInput.value = data.destDir;
      showNotification(
        `Created ${data.createdFiles.length} sample book files in "${data.sourceDir}". Click "Scan & Organize" (or enable Dry-Run) to test!`
      );
    } catch (err) {
      showNotification('Error generating sample books: ' + err.message);
    } finally {
      generateDemoBtn.disabled = false;
      generateDemoBtn.textContent = '+ Generate Sample Books';
    }
  });

  // Undo Last Batch Helper
  async function triggerUndo(batchId) {
    try {
      const res = await fetch('/api/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Nothing to undo');
      showNotification(
        `Reverted batch ${data.batchId}: restored ${data.restoredCount} file(s) to their original paths.`
      );
      await loadLibraryState();
    } catch (err) {
      showNotification('Undo notice: ' + err.message);
    }
  }

  undoLastBtn.addEventListener('click', () => triggerUndo());

  // Initial Load
  loadLibraryState();
})();
