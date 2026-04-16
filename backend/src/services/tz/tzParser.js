const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.resolve(__dirname, '../../../uploads');

/**
 * Validate that a file path is within the uploads directory (prevent path traversal).
 */
function assertSafePath(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(UPLOADS_DIR)) {
    throw new Error('File path is outside the allowed uploads directory');
  }
  return resolved;
}

/**
 * Parse a TZ file and extract raw text content.
 * Supports PDF, DOCX, and TXT formats.
 *
 * @param {string} filePath – absolute path to the uploaded file
 * @returns {Promise<string>} – extracted plain text
 */
async function parseFile(filePath) {
  const safePath = assertSafePath(filePath);
  const ext = path.extname(safePath).toLowerCase();

  switch (ext) {
    case '.pdf': {
      const pdfParse = require('pdf-parse');
      const buffer = await fs.promises.readFile(safePath);
      const data = await pdfParse(buffer);
      return data.text;
    }

    case '.docx': {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: safePath });
      return result.value;
    }

    case '.txt': {
      const text = await fs.promises.readFile(safePath, 'utf-8');
      return text;
    }

    default:
      throw new Error(`Unsupported file type: ${ext}. Supported: .pdf, .docx, .txt`);
  }
}

module.exports = { parseFile };
