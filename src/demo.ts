import fs from 'fs';
import path from 'path';

export interface SampleGenerationResult {
  sourceDir: string;
  destDir: string;
  createdFiles: string[];
}

/**
 * Generates a realistic set of local PDF, EPUB, MOBI, and DJVU books inside `sample-downloads/`
 * so users can immediately test scanning, sibling format aggregation, translation variant detection,
 * permission-gated cover downloads, dry-run reports, atomic organization, and undo logs.
 */
export function generateSampleBooks(rootDir: string): SampleGenerationResult {
  const sourceDir = path.join(rootDir, 'sample-downloads');
  const destDir = path.join(rootDir, 'sample-library');
  const subDuplicatesDir = path.join(sourceDir, 'old_backups');

  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(subDuplicatesDir, { recursive: true });

  const createdFiles: string[] = [];

  const writeSampleFile = (relPath: string, content: string) => {
    const full = path.join(sourceDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    createdFiles.push(full);
    return full;
  };

  // 1. Sibling format pair: principles_chem.pdf + principles_chem.epub (English edition, ISBN 9780134128924)
  const chemPdfContent = `%PDF-1.4
1 0 obj
<< /Title (Principles of Chemistry) /Author (Nivaldo J. Tro) /Subject (Inorganic and Physical Chemistry) /Lang (en-US) /Subtype /Image >>
endobj
2 0 obj
(ISBN 978-0-13-412892-4. Chapter 1: Matter, Measurement, and Problem Solving in the Chemical World. Atoms, molecules, stoichiometry, and chemical bonding principles.)
endobj
%%EOF`;

  writeSampleFile('principles_chem.pdf', chemPdfContent);
  writeSampleFile(
    'principles_chem.epub',
    `<package><metadata><dc:title>Principles of Chemistry</dc:title><dc:creator>Nivaldo J. Tro</dc:creator><dc:language>en</dc:language></metadata><body>ISBN 978-0-13-412892-4</body></package>`
  );

  // 2. French Translation Variant of Principles of Chemistry (same ISBN 9780134128924, language FR detected via n-gram)
  writeSampleFile(
    'principes_de_chimie_fr.pdf',
    `%PDF-1.4
1 0 obj
<< /Title (Principes de Chimie) /Author (Nivaldo J. Tro) /Subtype /Image >>
endobj
2 0 obj
(ISBN 978-0-13-412892-4. Chapitre 1: Les principes fondamentaux de la chimie générale dans le monde moderne avec les molécules et les réactions chimiques pour les étudiants.)
endobj
%%EOF`
  );

  // 3. Arabic Translation Variant of Principles of Chemistry (same ISBN 9780134128924, language AR detected via script)
  writeSampleFile(
    'principles_chem_arabic.pdf',
    `%PDF-1.4
1 0 obj
<< /Title (مبادئ الكيمياء العامة) /Author (Dr. Ahmed Kacem) /Subtype /Image >>
endobj
2 0 obj
(ISBN 978-0-13-412892-4. الفصل الأول: مبادئ الكيمياء العامة والروابط الكيميائية والتفاعلات في المحاليل المائية.)
endobj
%%EOF`
  );

  // 4. Organic Chemistry (PDF + MOBI sibling formats, missing embedded cover -> triggers Permission-Gated Cover Fetcher!)
  writeSampleFile(
    'organic_chemistry_synthesis.pdf',
    `%PDF-1.4
1 0 obj
<< /Title (Advanced Organic Chemistry and Stereochemistry) /Author (Francis A. Carey) /Lang (en) >>
endobj
2 0 obj
(ISBN 978-0-387-44897-8. Chapter 1: Chemical Bonding and Structure in Organic Molecules, Hydrocarbons, Carbonyl Synthesis, and Functional Groups.)
endobj
%%EOF`
  );
  writeSampleFile(
    'organic_chemistry_synthesis.mobi',
    `BOOKMOBI Advanced Organic Chemistry and Stereochemistry by Francis A. Carey ISBN 9780387448978`
  );

  // 5. Physics / Thermodynamics (matches rules.json regex rule `title =~ /thermodynamics/i -> Physics/Thermodynamics`)
  writeSampleFile(
    'Fundamentals of Engineering Thermodynamics - Michael J. Moran.pdf',
    `%PDF-1.4
1 0 obj
<< /Title (Fundamentals of Engineering Thermodynamics) /Author (Michael J. Moran) /Lang (en-US) /Subtype /Image >>
endobj
2 0 obj
(ISBN 978-1-118-41293-0. Chapter 1: Introductory Concepts and Definitions of Entropy, Statistical Mechanics, and Heat Transfer.)
endobj
%%EOF`
  );

  // 6. Physics / Quantum Mechanics (PDF + DJVU sibling formats, missing embedded cover -> triggers Cover Approval)
  writeSampleFile(
    'introduction_to_quantum_mechanics.pdf',
    `%PDF-1.4
1 0 obj
<< /Title (Introduction to Quantum Mechanics) /Author (David J. Griffiths) /Lang (en) >>
endobj
2 0 obj
(ISBN 978-1-107-18963-8. The Wavefunction, Schrodinger Equation, Quantum Field Theory, and Particle Physics.)
endobj
%%EOF`
  );
  writeSampleFile(
    'introduction_to_quantum_mechanics.djvu',
    `AT&TFORM DJVU Introduction to Quantum Mechanics by David J. Griffiths ISBN 9781107189638`
  );

  // 7. Computer Science / AI & Machine Learning
  writeSampleFile(
    'Deep Learning and Neural Networks - Ian Goodfellow.pdf',
    `%PDF-1.4
1 0 obj
<< /Title (Deep Learning and Neural Networks) /Author (Ian Goodfellow) /Lang (en-US) /Subtype /Image >>
endobj
2 0 obj
(ISBN 978-0-262-03561-3. Applied Math and Machine Learning Basics, Deep Feedforward Networks, Optimization, and Artificial Intelligence.)
endobj
%%EOF`
  );

  // 8. Computer Science / Algorithms (PDF + EPUB sibling formats)
  writeSampleFile(
    'algorithm_design_manual.pdf',
    `%PDF-1.4
1 0 obj
<< /Title (The Algorithm Design Manual) /Author (Steven S. Skiena) /Lang (en-US) /Subtype /Image >>
endobj
2 0 obj
(ISBN 978-3-030-54255-9. Practical Algorithm Design, Data Structures, Graph Theory, Combinatorics, and Dynamic Programming.)
endobj
%%EOF`
  );
  writeSampleFile(
    'algorithm_design_manual.epub',
    `<package><metadata><dc:title>The Algorithm Design Manual</dc:title><dc:creator>Steven S. Skiena</dc:creator><dc:language>en</dc:language></metadata></package>`
  );

  // 9. Exact SHA-256 Duplicate File in a nested folder with a different filename
  writeSampleFile('old_backups/copy_of_chem_2025.pdf', chemPdfContent);

  return {
    sourceDir,
    destDir,
    createdFiles,
  };
}
