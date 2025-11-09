// utils/buildTicketPdf.js
const PDFDocument = require('pdfkit');

function buildTicketPdf({ eventTitle, clubName, eventDate, venue, serial, qrPngBuffer, buyerName, seatLabel }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const bufs = [];

      // Paleta NightVibe
      const COLOR_BG = '#0b0f19';       // fondo general
      const COLOR_CARD = '#0d1220';     // tarjeta
      const COLOR_STROKE = '#1e293b';   // bordes
      const COLOR_TEXT = '#e5e7eb';     // texto base
      const COLOR_MUTED = '#93a4bf';    // texto suave
      const COLOR_ACCENT = '#00e5ff';   // cian NightVibe

      doc.on('data', (d) => bufs.push(d));
      doc.on('end', () => resolve(Buffer.concat(bufs)));

      // Fondo
      doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLOR_BG);

      // Tarjeta principal
      const cardX = 36;
      const cardY = 36;
      const cardW = doc.page.width - 72;
      const cardH = doc.page.height - 72;

      // Glow exterior (marco doble sutil)
      doc.save()
        .roundedRect(cardX - 2, cardY - 2, cardW + 4, cardH + 4, 16)
        .lineWidth(1)
        .strokeColor('#082032')
        .stroke()
        .restore();

      // Tarjeta con borde cian
      doc.save()
        .roundedRect(cardX, cardY, cardW, cardH, 14)
        .lineWidth(1.6)
        .fillAndStroke(COLOR_CARD, COLOR_STROKE)
        .restore();

      // Bordes interiores con acento muy fino
      doc.save()
        .roundedRect(cardX + 1.5, cardY + 1.5, cardW - 3, cardH - 3, 12)
        .lineWidth(0.6)
        .strokeColor('#053a44')
        .stroke()
        .restore();

      // Encabezado
      const headerY = cardY + 18;
      doc.fillColor(COLOR_MUTED).fontSize(10).text('NIGHTVIBE — DIGITAL TICKET', cardX + 22, headerY);

      // Club pill
      if (clubName) {
        const pillX = cardX + 22;
        const pillY = headerY + 18;
        const pillH = 22;
        const pillPad = 12;
        const pillText = String(clubName).toUpperCase();
        const pillW = doc.widthOfString(pillText) + pillPad * 2;
        doc.save()
          .roundedRect(pillX, pillY, pillW, pillH, 11)
          .fillOpacity(0.12)
          .fill(COLOR_ACCENT)
          .restore();
        doc.fillColor(COLOR_ACCENT).fontSize(11).text(pillText, pillX + pillPad, pillY + 5, { width: pillW - pillPad * 2, align: 'left' });
      }

      // Evento — tipografía grande
      const titleY = headerY + (clubName ? 50 : 30);
      doc.fillColor('#f1f5f9').fontSize(28).text(eventTitle || 'Evento', cardX + 22, titleY, { width: cardW - 44 });

      // Subinfo (fecha + venue)
      let subY = titleY + 34;
      if (eventDate) {
        doc.fillColor('#cbd5e1').fontSize(12).text(eventDate, cardX + 22, subY, { width: cardW - 44 });
        subY += 16;
      }
      if (venue) {
        doc.fillColor('#9fb0c9').fontSize(12).text(venue, cardX + 22, subY, { width: cardW - 44 });
        subY += 12;
      }

      // Línea divisoria
      const sepY = (cardY + 110);
      doc.moveTo(cardX + 14, sepY).lineTo(cardX + cardW - 14, sepY).lineWidth(1).stroke(COLOR_STROKE);

      // Bloque datos + QR
      const leftX = cardX + 22;
      const topY = sepY + 16;

      // Datos
      doc.fillColor(COLOR_TEXT).fontSize(12);
      const lineH = 18;
      let y = topY;

      if (buyerName) {
        doc.text('Comprador', leftX, y);
        doc.fillColor('#cbd5e1').text(buyerName, leftX + 100, y);
        y += lineH;
        doc.fillColor(COLOR_TEXT);
      }

      if (seatLabel) {
        doc.text('Entrada', leftX, y);
        doc.fillColor('#cbd5e1').text(seatLabel, leftX + 100, y);
        y += lineH;
        doc.fillColor(COLOR_TEXT);
      }

      doc.text('Serial', leftX, y);
      doc.fillColor('#cbd5e1').text(serial || '—', leftX + 100, y);
      y += lineH;

      doc.fillColor(COLOR_MUTED).fontSize(10)
        .text('Muestra este QR en la entrada. La reventa o alteración invalida la entrada.', leftX, y + 6, { width: 320 });

      // QR
      const qrSize = 220;
      const qrX = cardX + cardW - qrSize - 32;
      const qrY = topY - 8;

      try {
        doc.save();
        // Marco doble
        doc.roundedRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 12).lineWidth(1).stroke(COLOR_STROKE);
        doc.roundedRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 10).lineWidth(1).stroke(COLOR_ACCENT);
        doc.image(qrPngBuffer, qrX, qrY, { width: qrSize, height: qrSize });
        doc.restore();
        doc.fillColor(COLOR_MUTED).fontSize(9).text('SCAN ME', qrX, qrY + qrSize + 8, { width: qrSize, align: 'center' });
      } catch (_) {
        // omit QR if fails
      }

      // Footer
      const footerY = cardY + cardH - 40;
      doc.moveTo(cardX + 14, footerY - 10).lineTo(cardX + cardW - 14, footerY - 10).lineWidth(0.6).stroke(COLOR_STROKE);
      doc.fillColor(COLOR_MUTED).fontSize(9);
      doc.text('NightVibe • nightvibe.life', cardX + 22, footerY);
      doc.fillColor(COLOR_ACCENT).text(`Ticket: ${serial || '—'}`, cardX + cardW - 200, footerY, { width: 180, align: 'right' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildTicketPdf };
