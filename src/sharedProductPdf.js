import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const SHARED_PRODUCT_PDF_MAX_BYTES = 20 * 1024 * 1024;

const pdfDir = path.join(config.dataDir, 'pdf');
const managedPdfPath = path.join(pdfDir, 'shared-product-brochure.pdf');
const selectionPath = path.join(pdfDir, 'selection.json');

function readSelection() {
  try {
    return JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  } catch {
    return null;
  }
}

function pdfFiles() {
  if (!fs.existsSync(pdfDir)) return [];
  return fs
    .readdirSync(pdfDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
    .map((entry) => entry.name)
    .sort();
}

function resolveSelection() {
  const selection = readSelection();
  if (selection?.cleared) return null;

  if (selection?.fileName) {
    const fileName = path.basename(String(selection.fileName));
    const filePath = path.join(pdfDir, fileName);
    if (fileName.toLowerCase().endsWith('.pdf') && fs.existsSync(filePath)) {
      return {
        filePath,
        name: selection.originalName || fileName,
        updatedAt: selection.updatedAt,
      };
    }
    return null;
  }

  // A single PDF manually placed in data/pdf is selected automatically. This
  // makes the user's existing brochure immediately usable without duplicating
  // or moving it; subsequent UI choices are recorded in selection.json.
  const candidates = pdfFiles();
  if (candidates.length !== 1) return null;
  const fileName = candidates[0];
  return { filePath: path.join(pdfDir, fileName), name: fileName };
}

export function getSharedProductPdfPath() {
  return resolveSelection()?.filePath || null;
}

export function getSharedProductPdfInfo() {
  const selected = resolveSelection();
  if (!selected) return { selected: false, name: null, size: 0, updatedAt: null };
  const stat = fs.statSync(selected.filePath);
  return {
    selected: true,
    name: selected.name,
    size: stat.size,
    updatedAt: selected.updatedAt || stat.mtime.toISOString(),
  };
}

function validatePdf(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Select a non-empty PDF file');
  if (buffer.length > SHARED_PRODUCT_PDF_MAX_BYTES) throw new Error('PDF must be 20 MB or smaller');
  if (!String(originalName || '').toLowerCase().endsWith('.pdf')) throw new Error('Selected file must end in .pdf');

  // Validate file content as well as its extension/MIME type. A PDF header is
  // normally at byte zero, but ISO 32000 readers permit leading bytes.
  const header = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  if (!header.includes('%PDF-')) throw new Error('Selected file is not a valid PDF');
}

export function saveSharedProductPdf(buffer, originalName) {
  const safeOriginalName = path.basename(String(originalName || 'brochure.pdf')).slice(0, 180);
  validatePdf(buffer, safeOriginalName);
  fs.mkdirSync(pdfDir, { recursive: true });
  fs.writeFileSync(managedPdfPath, buffer);
  const metadata = {
    fileName: path.basename(managedPdfPath),
    originalName: safeOriginalName,
    size: buffer.length,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(selectionPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return getSharedProductPdfInfo();
}

export function clearSharedProductPdf() {
  fs.mkdirSync(pdfDir, { recursive: true });
  fs.writeFileSync(
    selectionPath,
    `${JSON.stringify({ cleared: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  return getSharedProductPdfInfo();
}
