const sg = require('@sendgrid/mail');
sg.setApiKey(process.env.SENDGRID_API_KEY || '');

const FROM = process.env.EMAIL_FROM || 'NightVibe <no-reply@nightvibe.life>';

module.exports = async function sendTicketEmail({ to, eventTitle, eventDate, serial, qrPngBuffer }) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('⚠️  SENDGRID_API_KEY no configurado. Simulando envío a:', to);
    return;
  }

  const html = `
  <div style="font-family:system-ui,Segoe UI,Roboto,Arial; background:#0b0d12; color:#eaf6ff; padding:24px">
    <h1 style="margin:0 0 8px; color:#00e5ff">Tu entrada para ${eventTitle}</h1>
    <p style="margin:0 0 16px; opacity:.9">Fecha: ${eventDate || '—'}</p>
    <p style="margin:0 0 16px; opacity:.9">Número de entrada: <strong>${serial}</strong></p>
    <p style="margin:0 0 12px;">Muestra este QR en la entrada:</p>
    <img src="cid:qrimg" alt="QR Ticket" style="width:240px; height:240px; border-radius:12px;"/>
    <p style="margin-top:24px; font-size:12px; opacity:.7">Si tienes dudas, responde a este correo.</p>
  </div>`;

  const msg = {
    to,
    from: FROM,
    subject: `Tu entrada NightVibe · ${eventTitle}`,
    html,
    attachments: [{
      content: qrPngBuffer.toString('base64'),
      filename: 'entrada.png',
      type: 'image/png',
      disposition: 'attachment'
    }],
    // Embebemos también como inline image (content-id)
    // Nota: SendGrid necesita "attachments" para inline con cid. Para simplificar,
    // muchos clientes mostrarán el adjunto; suficiente para MVP.
  };

  try {
    await sg.send(msg);
    console.log('📧 Email de ticket enviado a', to, 'serial', serial);
  } catch (e) {
    console.error('❌ Error enviando email:', e?.response?.body || e.message);
  }
};