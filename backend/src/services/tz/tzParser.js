const fs = require('fs');
const path = require('path');

/**
 * Parse a TZ file and extract raw text content.
 * Supports PDF, DOCX, and TXT formats.
 *
 * @param {string} filePath – absolute path to the uploaded file
 * @returns {Promise<string>} – extracted plain text
 */
async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.pdf': {
      const pdfParse = require('pdf-parse');
      const buffer = await fs.promises.readFile(filePath);
      const data = await pdfParse(buffer);
      return data.text;
    }

    case '.docx': {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }

    case '.txt': {
      const text = await fs.promises.readFile(filePath, 'utf-8');
      return text;
    }

    default:
      throw new Error(`Unsupported file type: ${ext}. Supported: .pdf, .docx, .txt`);
  }
}

module.exports = { parseFile };
