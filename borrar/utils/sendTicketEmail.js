// utils/sendTicketEmail.js
const sgMail = require('@sendgrid/mail');
const { buildTicketPdf } = require('./buildTicketPdf');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Envía el email de la entrada con:
 *  - QR embebido inline (para que se vea dentro del correo)
 *  - PDF adjunto (ticket.pdf)
 *
 * @param {Object} opts
 * @param {string} opts.to                Email del comprador
 * @param {string} opts.eventTitle        Título del evento
 * @param {string} [opts.clubName]        Nombre del club/organizador
 * @param {string} [opts.eventDate]       Fecha/hora legible (ej: "Sáb, 26 Oct 2025 — 23:00")
 * @param {string} [opts.venue]           Lugar/sala/dirección corta
 * @param {string} opts.serial            Serial del ticket (ej: NV-AB12-3F)
 * @param {Buffer} opts.qrPngBuffer       PNG del QR (Buffer)
 * @param {string} [opts.buyerName]       Nombre del comprador (si lo tienes)
 * @param {string} [opts.seatLabel]       Etiqueta de entrada/asiento/mesa (opcional)
 */
async function sendTicketEmail({
  to,
  eventTitle,
  clubName = '',
  eventDate = '',
  venue = '',
  serial,
  qrPngBuffer,
  buyerName = '',
  seatLabel = '',
}) {
  if (!process.env.SENDGRID_FROM) {
    throw new Error('Falta la variable SENDGRID_FROM (remitente) en el .env');
  }

  // PDF adjunto
  const pdfBuffer = await buildTicketPdf({
    eventTitle,
    clubName,
    eventDate,
    venue,
    serial,
    qrPngBuffer,
    buyerName,
    seatLabel,
  });

  // Imagen QR inline: la referenciamos en el HTML con cid:qrimg
  const qrAsBase64 = qrPngBuffer.toString('base64');
  const pdfAsBase64 = pdfBuffer.toString('base64');

  const safeTitle = escapeHtml(eventTitle);
  const safeVenue = escapeHtml(venue);
  const safeSerial = escapeHtml(serial);
  const safeBuyer = escapeHtml(buyerName || '');
  const safeDate  = escapeHtml(eventDate || '');
  const safeClub  = escapeHtml(clubName || '');
  const safeSeat  = escapeHtml(seatLabel || '');

  const subject = `🎟️ ${safeClub ? safeClub + ' — ' : ''}Tu entrada: ${eventTitle}${eventDate ? ' · ' + eventDate : ''}`;

  const html = `
  <div style="background:#0b0f19;padding:24px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e5e7eb;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:680px;margin:0 auto;background:#0d1220;border:1px solid #1e293b;border-radius:14px;overflow:hidden">
      <tr>
        <td style="padding:22px 22px 10px;border-bottom:1px solid #1e293b;">
          <div style="font-size:13px;color:#93a4bf;letter-spacing:.04em;">NIGHTVIBE • TICKET</div>
          <h1 style="margin:6px 0 0;font-size:22px;line-height:1.25;color:#f1f5f9">${safeTitle}</h1>
          ${safeClub ? `<div style="margin-top:8px;display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(0,229,255,.12);color:#00e5ff;font-size:11px;letter-spacing:.03em">${safeClub.toUpperCase()}</div>` : ''}
          ${safeDate ? `<div style="margin-top:4px;color:#cbd5e1">${safeDate}</div>` : ''}
          ${safeVenue ? `<div style="margin-top:2px;color:#9fb0c9">${safeVenue}</div>` : ''}
        </td>
      </tr>

      <tr>
        <td style="padding:18px 22px 8px;">
          ${safeBuyer ? `<div style="margin-bottom:8px"><b style="color:#e5e7eb">Comprador:</b> <span style="color:#cbd5e1">${safeBuyer}</span></div>` : ``}
          ${safeSeat ? `<div style="margin-bottom:8px"><b style="color:#e5e7eb">Entrada:</b> <span style="color:#cbd5e1">${safeSeat}</span></div>` : ``}
          <div style="margin-bottom:10px"><b style="color:#e5e7eb">Serial:</b> <span style="color:#cbd5e1">${safeSerial}</span></div>
          <div style="margin:12px 0 18px;color:#93a4bf;font-size:13px">Presenta este QR en la entrada. También adjuntamos un PDF como alternativa.</div>

          <div style="text-align:center;padding:18px;background:#0b0f19;border:1px solid #1e293b;border-radius:12px">
            <img src="cid:qrimg" width="240" height="240" alt="QR Entrada" style="display:inline-block;border-radius:10px" />
          </div>

          <div style="margin-top:18px;color:#9fb0c9;font-size:12px;line-height:1.5">
            Si el QR no se muestra correctamente, abre el adjunto <b>ticket.pdf</b>.
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding:16px 22px;border-top:1px solid #1e293b;color:#93a4bf;font-size:12px">
          Este email fue enviado a <span style="color:#cbd5e1">${escapeHtml(to)}</span>.
        </td>
      </tr>
    </table>
  </div>
  `;

  const text = `Tu entrada de NightVibe
${clubName ? 'Club: ' + clubName + '\n' : ''}Evento: ${eventTitle}
${eventDate ? 'Fecha: ' + eventDate + '\n' : ''}${venue ? 'Lugar: ' + venue + '\n' : ''}${seatLabel ? 'Entrada: ' + seatLabel + '\n' : ''}Serial: ${serial}

Adjuntamos un PDF con tu ticket por si el QR no se muestra en tu cliente de email.`;

  const msg = {
    to,
    from: process.env.SENDGRID_FROM, // ej: "NightVibe <tickets@nightvibe.life>"
    subject,
    text,
    html,
    attachments: [
      // QR inline
      {
        content: qrAsBase64,
        filename: 'qr.png',
        type: 'image/png',
        disposition: 'inline',
        content_id: 'qrimg',
      },
      // PDF adjunto
      {
        content: pdfAsBase64,
        filename: 'ticket.pdf',
        type: 'application/pdf',
        disposition: 'attachment',
      },
    ],
  };

  await sgMail.send(msg);
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = sendTicketEmail;


/*// utils/sendTicketEmail.js
const sgMail = require('@sendgrid/mail');
const { buildTicketPdf } = require('./buildTicketPdf');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);


async function sendTicketEmail({
  to,
  eventTitle,
  eventDate = '',
  venue = '',
  serial,
  qrPngBuffer,
  buyerName = '',
}) {
  if (!process.env.SENDGRID_FROM) {
    throw new Error('Falta la variable SENDGRID_FROM (remitente) en el .env');
  }

  // PDF adjunto
  const pdfBuffer = await buildTicketPdf({
    eventTitle,
    eventDate,
    venue,
    serial,
    qrPngBuffer,
    buyerName,
  });

  // Imagen QR inline: la referenciamos en el HTML con cid:qrimg
  const qrAsBase64 = qrPngBuffer.toString('base64');
  const pdfAsBase64 = pdfBuffer.toString('base64');

  const safeTitle = escapeHtml(eventTitle);
  const safeVenue = escapeHtml(venue);
  const safeSerial = escapeHtml(serial);
  const safeBuyer = escapeHtml(buyerName || '');
  const safeDate  = escapeHtml(eventDate || '');

  const subject = `🎟️ Tu entrada: ${eventTitle}${eventDate ? ' · ' + eventDate : ''}`;

  const html = `
  <div style="background:#0b0f19;padding:24px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e5e7eb;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:680px;margin:0 auto;background:#0d1220;border:1px solid #1e293b;border-radius:14px;overflow:hidden">
      <tr>
        <td style="padding:22px 22px 10px;border-bottom:1px solid #1e293b;">
          <div style="font-size:13px;color:#93a4bf;letter-spacing:.04em;">NIGHTVIBE • TICKET</div>
          <h1 style="margin:6px 0 0;font-size:22px;line-height:1.25;color:#f1f5f9">${safeTitle}</h1>
          ${safeDate ? `<div style="margin-top:4px;color:#cbd5e1">${safeDate}</div>` : ''}
          ${safeVenue ? `<div style="margin-top:2px;color:#9fb0c9">${safeVenue}</div>` : ''}
        </td>
      </tr>

      <tr>
        <td style="padding:18px 22px 8px;">
          ${safeBuyer ? `<div style="margin-bottom:8px"><b style="color:#e5e7eb">Comprador:</b> <span style="color:#cbd5e1">${safeBuyer}</span></div>` : ``}
          <div style="margin-bottom:10px"><b style="color:#e5e7eb">Serial:</b> <span style="color:#cbd5e1">${safeSerial}</span></div>
          <div style="margin:12px 0 18px;color:#93a4bf;font-size:13px">Presenta este QR en la entrada. También adjuntamos un PDF como alternativa.</div>

          <div style="text-align:center;padding:18px;background:#0b0f19;border:1px solid #1e293b;border-radius:12px">
            <img src="cid:qrimg" width="240" height="240" alt="QR Entrada" style="display:inline-block;border-radius:10px" />
          </div>

          <div style="margin-top:18px;color:#9fb0c9;font-size:12px;line-height:1.5">
            Si el QR no se muestra correctamente, abre el adjunto <b>ticket.pdf</b>.
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding:16px 22px;border-top:1px solid #1e293b;color:#93a4bf;font-size:12px">
          Este email fue enviado a <span style="color:#cbd5e1">${escapeHtml(to)}</span>.
        </td>
      </tr>
    </table>
  </div>
  `;

  const text = `Tu entrada de NightVibe
Evento: ${eventTitle}
${eventDate ? 'Fecha: ' + eventDate + '\n' : ''}${venue ? 'Lugar: ' + venue + '\n' : ''}Serial: ${serial}

Adjuntamos un PDF con tu ticket por si el QR no se muestra en tu cliente de email.`;

  const msg = {
    to,
    from: process.env.SENDGRID_FROM, // ej: "NightVibe <tickets@nightvibe.life>"
    subject,
    text,
    html,
    attachments: [
      // QR inline
      {
        content: qrAsBase64,
        filename: 'qr.png',
        type: 'image/png',
        disposition: 'inline',
        content_id: 'qrimg',
      },
      // PDF adjunto
      {
        content: pdfAsBase64,
        filename: 'ticket.pdf',
        type: 'application/pdf',
        disposition: 'attachment',
      },
    ],
  };

  await sgMail.send(msg);
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = sendTicketEmail;*/
