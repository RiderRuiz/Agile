const nodemailer = require('nodemailer');
const https = require('https');
const { Op } = require('sequelize');
const { Debt, User, Loan } = require('./models');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function getTodayDateOnly() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(dateStr) {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function buildTransporter() {
  if (!process.env.SMTP_HOST) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined
  });
}

function addDays(dateStr, days) {
  const parts = dateStr.split('-').map((p) => Number(p));
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchDueTodayOrSoon() {
  const today = getTodayDateOnly();
  const daysAhead = Number(process.env.NOTIFY_DAYS_AHEAD || 0);
  const endDate = daysAhead > 0 ? addDays(today, daysAhead) : today;
  return Debt.findAll({
    where: {
      status: 'pending',
      due_date: {
        [Op.between]: [today, endDate]
      }
    },
    include: [
      { model: User, attributes: ['id', 'name', 'email', 'phone'] },
      { model: Loan, as: 'loan', attributes: ['id', 'name'] }
    ],
    order: [['due_date', 'ASC']]
  });
}

function buildEmail(debtsByUser) {
  const lines = ['Tienes deudas que vencen hoy:', ''];
  debtsByUser.forEach((debt) => {
    const loan = debt.loan ? `${debt.loan.name} - ` : '';
    lines.push(`- Deuda pendiente: ${loan}${debt.name} vence ${formatDisplayDate(debt.due_date)} (S/ ${Number(debt.amount).toFixed(2)})`);
  });
  lines.push('', 'Ingresa a Agile Deudas para registrarlas como pagadas.');
  return lines.join('\n');
}

function buildSms(debtsByUser) {
  const parts = ['Tienes deudas que vencen hoy:'];
  debtsByUser.forEach((debt) => {
    const loan = debt.loan ? `${debt.loan.name} - ` : '';
    parts.push(`Deuda pendiente: ${loan}${debt.name} vence ${formatDisplayDate(debt.due_date)} (S/ ${Number(debt.amount).toFixed(2)})`);
  });
  parts.push('Registra el pago en Agile Deudas.');
  return parts.join('\n');
}

function triggerIfttt(eventName, key, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'maker.ifttt.com',
      port: 443,
      path: `/trigger/${encodeURIComponent(eventName)}/with/key/${key}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendEmailForUser(transporter, user, debts) {
  const to = user.email || process.env.NOTIFY_FALLBACK_EMAIL;
  if (!to) {
    console.log(
      `[notifier] Usuario ${user.id} sin email configurado. Deudas:`,
      debts.map((d) => d.name).join(', ')
    );
    return;
  }
  if (!transporter) {
    console.log(`[notifier] SMTP no configurado. Notificar a ${to}:`);
    debts.forEach((d) => console.log(` - ${d.name} vence hoy (${d.due_date})`));
    return;
  }
  await transporter.sendMail({
    from: process.env.NOTIFY_EMAIL_FROM || process.env.SMTP_USER || 'agile@localhost',
    to,
    subject: 'Recordatorio: deudas vencen hoy',
    text: buildEmail(debts)
  });
}

async function sendSmsForUser(client, user, debts) {
  const key = process.env.IFTTT_KEY;
  const event = process.env.IFTTT_EVENT || 'sms_due';
  if (!key) return;
  const to = user.phone || process.env.NOTIFY_SMS_TO || process.env.NOTIFY_PHONE_FALLBACK;
  if (!to) {
    console.log(`[notifier] SMS omitido: sin telefono configurado para usuario ${user.id}`);
    return;
  }
  await triggerIfttt(event, key, { value1: to, value2: buildSms(debts) });
}

async function sendDueToday() {
  const transporter = buildTransporter();
  const debts = await fetchDueTodayOrSoon();
  if (!debts || debts.length === 0) {
    return 0;
  }

  const grouped = debts.reduce((map, debt) => {
    const userId = debt.User.id;
    if (!map.has(userId)) {
      map.set(userId, { user: debt.User, debts: [] });
    }
    map.get(userId).debts.push(debt);
    return map;
  }, new Map());

  for (const { user, debts: userDebts } of grouped.values()) {
    try {
      await sendEmailForUser(transporter, user, userDebts);
      await sendSmsForUser(null, user, userDebts);
    } catch (err) {
      console.error(`[notifier] Error notificando a ${user.email || user.id}:`, err.message);
    }
  }

  return debts.length;
}

function scheduleTodayNotifier() {
  if (process.env.ENABLE_TODAY_NOTIFIER !== 'true') {
    console.log('[notifier] Notificador diario desactivado (ENABLE_TODAY_NOTIFIER != true)');
    return null;
  }

  let lastRun = null;
  const run = async () => {
    const today = getTodayDateOnly();
    if (lastRun === today) return;
    try {
      const count = await sendDueToday();
      if (count > 0) {
        console.log(`[notifier] Notificaciones enviadas para ${count} deuda(s) que vencen hoy.`);
      } else {
        console.log('[notifier] No hay deudas que venzan hoy.');
      }
    } catch (err) {
      console.error('[notifier] Error al enviar notificaciones:', err.message);
    } finally {
      lastRun = today;
    }
  };

  run();
  const interval = setInterval(run, ONE_DAY_MS / 24);
  return interval;
}

if (require.main === module) {
  sendDueToday()
    .then((count) => {
      console.log(`[notifier] Finalizado. Deudas notificadas hoy: ${count}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[notifier] Error en ejecucion manual:', err);
      process.exit(1);
    });
}

module.exports = { sendDueToday, scheduleTodayNotifier };
