// utils/buildTicketPdf.js
const PDFDocument = require('pdfkit');

function buildTicketPdf({ eventTitle, eventDate, venue, serial, qrPngBuffer, buyerName }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const bufs = [];
      doc.on('data', (d) => bufs.push(d));
      doc.on('end', () => resolve(Buffer.concat(bufs)));

      // Fondo suave
      doc.rect(0, 0, doc.page.width, doc.page.height).fill('#0b0f19');
      doc.fillColor('#0b0f19'); // reset

      // Card
      const cardX = 36;
      const cardY = 36;
      const cardW = doc.page.width - 72;
      const cardH = doc.page.height - 72;

      // Borde/box
      doc.save()
        .roundedRect(cardX, cardY, cardW, cardH, 14)
        .lineWidth(1.2)
        .fillAndStroke('#0d1220', '#1e293b')
        .restore();

      // TÍTULO
      doc
        .fillColor('#93a4bf')
        .fontSize(10)
        .text('NIGHTVIBE • TICKET', cardX + 22, cardY + 20);

      doc
        .fillColor('#f1f5f9')
        .fontSize(22)
        .text(eventTitle || 'Evento', cardX + 22, cardY + 36, { width: cardW - 44 });

      if (eventDate) {
        doc.fillColor('#cbd5e1').fontSize(12).text(eventDate, { paragraphGap: 2 });
      }
      if (venue) {
        doc.fillColor('#9fb0c9').fontSize(12).text(venue);
      }

      // Línea divisoria
      doc.moveTo(cardX + 14, cardY + 96).lineTo(cardX + cardW - 14, cardY + 96).stroke('#1e293b');

      // Bloque datos + QR
      const leftX = cardX + 22;
      const topY = cardY + 110;

      // Datos
      doc.fillColor('#e5e7eb').fontSize(12);
      if (buyerName) {
        doc.text(`Comprador: `, leftX, topY);
        doc.fillColor('#cbd5e1').text(buyerName, { continued: false });
      }
      doc.fillColor('#e5e7eb').moveDown(0.4).text(`Serial: `);
      doc.fillColor('#cbd5e1').text(serial || '—');

      doc.fillColor('#93a4bf').moveDown(0.8).fontSize(10)
        .text('Muestra el código en la entrada. La reventa o alteración invalida la entrada.');

      // QR
      const qrSize = 220;
      const qrX = cardX + cardW - qrSize - 22;
      const qrY = topY - 8;

      try {
        // pdfkit acepta buffer con formato.
        doc.image(qrPngBuffer, qrX, qrY, { width: qrSize, height: qrSize });
        // Marco suave
        doc.roundedRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 10).stroke('#1e293b');
      } catch (_) {
        // Si por alguna razón falla, simplemente omitimos el QR
      }

      // Footer
      doc.fillColor('#93a4bf').fontSize(9);
      doc.text('NightVibe • nightvibe.life', cardX + 22, cardY + cardH - 32);
      doc.text(`Ticket: ${serial || '—'}`, cardX + cardW - 160, cardY + cardH - 32, { width: 140, align: 'right' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildTicketPdf };
