const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const root = __dirname;
const column = { width: 468 };

function writePdf(fileName, options, write) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(options);
    const out = fs.createWriteStream(path.join(root, fileName));
    out.on('finish', resolve);
    out.on('error', reject);
    doc.on('error', reject);
    doc.pipe(out);
    write(doc);
    doc.end();
  });
}

async function main() {
  await writePdf('booklet.pdf', { info: { Title: 'Distiller Booklet' }, margin: 72, bufferPages: true }, (doc) => {
    doc.outline.addItem('Preface');
    doc.font('Times-Roman').fontSize(12).text(
      'This preface thanks the people who waited while the book was written. It remembers a rainy afternoon and a long walk home. None of that is a rule you need to keep.',
      column,
    );

    doc.addPage();
    doc.outline.addItem('A numbered rule');
    doc.font('Times-Roman').fontSize(12).text('1. Flush the log before changing memory.', column);
    doc.moveDown();
    doc.text('Example. During the outage the log still held the write, and memory did not.', column);

    doc.addPage();
    doc.outline.addItem('A listing');
    doc.font('Times-Roman').fontSize(12).text("The listing below is the book's own code.", column);
    doc.moveDown();
    doc.font('Courier').fontSize(12).text('wal.append(key, val)?;', column);
    doc.text('mem.put(key, val);', column);
    doc.moveDown();
    doc.font('Times-Roman').fontSize(12).text('Figure. A box drawn beside the listing.', column);
    const figureTop = doc.y + 16;
    doc.rect(72, figureTop, 240, 100).stroke();
    doc.moveTo(72, figureTop).lineTo(312, figureTop + 100).stroke();

    doc.addPage();
    doc.font('Times-Roman').fontSize(12).text(
      'This trailing page sits outside the outline. It still has a selectable text layer so the file can be accepted.',
      column,
    );
  });

  await writePdf(
    'mostly-page-numbers.pdf',
    { info: { Title: 'Scanned Notes' }, margin: 72, bufferPages: true },
    (doc) => {
      doc.font('Times-Roman').fontSize(12);
      doc.text('This page has enough letters to count as a real text page for the reader.', column);
      doc.addPage();
      doc.text('This second page also has enough letters to count as readable text.', column);
      for (const numeral of ['3', '4', '5']) {
        doc.addPage();
        doc.text(numeral, column);
      }
    },
  );

  await writePdf('untitled.pdf', { margin: 72 }, (doc) => {
    doc.font('Times-Roman').fontSize(12).text(
      'This page has a text layer and no title in the document information dictionary.',
      column,
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
