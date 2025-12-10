const { Payment, Debt, Loan } = require('../models');
// Compatibilidad: usa fetch nativo en Node 18+ o recurre a node-fetch (ESM) en versiones anteriores.
const fetch = (...args) =>
  (typeof global.fetch === 'function'
    ? global.fetch(...args)
    : import('node-fetch').then(({ default: f }) => f(...args)));

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || '';
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const BACKEND_URL = (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, '');

function computePayableAmount(debt) {
  const base = Number(debt.amount) || 0;
  const due = new Date(debt.due_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isOverdue = !Number.isNaN(due.getTime()) && due < today && debt.status !== 'paid';
  const penalty = isOverdue ? Math.round(base * 0.05 * 100) / 100 : 0;
  const total = Math.round((base + penalty) * 100) / 100;
  return { total, penalty };
}

async function listPayments(req, res) {
  try {
    const payments = await Payment.findAll({
      include: [
        {
          model: Debt,
          as: 'debt',
          attributes: ['id', 'name', 'due_date', 'amount', 'loan_id', 'user_id'],
          include: [
            { model: Loan, as: 'loan', attributes: ['id', 'name'] }
          ]
        }
      ],
      where: {
        '$debt.user_id$': req.user.id
      },
      order: [['paid_at', 'DESC']]
    });

    const payload = payments.map((payment) => {
      const debt = payment.debt || {};
      const loan = debt.loan || null;
      return {
        id: payment.id,
        amount: Number(payment.amount),
        paid_at: payment.paid_at,
        debt_id: debt.id,
        debt_name: debt.name,
        due_date: debt.due_date,
        loan_name: loan ? loan.name : null,
        method: payment.method,
        reference: payment.reference
      };
    });

    res.json(payload);
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener pagos', error: err.message });
  }
}

async function createPayPalOrder(req, res) {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    return res.status(500).json({ message: 'PayPal no configurado' });
  }
  const debtId = req.body.debtId;
  if (!debtId) return res.status(400).json({ message: 'debtId requerido' });

  try {
    const debt = await Debt.findOne({
      where: { id: debtId, user_id: req.user.id },
      include: [{ model: Loan, as: 'loan', attributes: ['id', 'name'] }]
    });
    if (!debt) return res.status(404).json({ message: 'Deuda no encontrada' });
    if (debt.status === 'paid') return res.status(409).json({ message: 'La deuda ya está pagada' });

    const { total } = computePayableAmount(debt);
    if (total <= 0) return res.status(400).json({ message: 'Monto a pagar inválido' });

    const title = debt.loan ? `${debt.loan.name} - ${debt.name}` : debt.name;
    const frontUrlRaw = process.env.FRONTEND_URL || 'http://localhost:5173';
    const frontUrl = frontUrlRaw ? frontUrlRaw.replace(/\/+$/, '') : 'http://localhost:5173';

    // Obtener access token de PayPal
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
    const tokenResp = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) {
      return res.status(500).json({ message: 'Error autenticando con PayPal', error: tokenData });
    }

    // Crear orden
    const orderResp = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenData.access_token}`
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: {
              currency_code: 'USD',
              value: total.toFixed(2)
            },
            description: title,
            custom_id: `${debt.id}:${req.user.id}`
          }
        ],
        application_context: {
          return_url: `${BACKEND_URL}/api/payments/paypal/capture?debtId=${debt.id}&userId=${req.user.id}`,
          cancel_url: `${frontUrl}/`
        }
      })
    });
    const orderData = await orderResp.json();
    if (!orderResp.ok) {
      return res.status(500).json({ message: 'Error al crear orden PayPal', error: orderData });
    }

    const approval = (orderData.links || []).find(l => l.rel === 'approve');
    res.json({
      id: orderData.id,
      approval_url: approval ? approval.href : null
    });
  } catch (err) {
    console.error('[paypal] error al crear orden:', err);
    res.status(500).json({ message: 'Error al crear orden PayPal', error: err.message });
  }
}

async function capturePayPalOrder(req, res) {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    return res.status(500).json({ message: 'PayPal no configurado' });
  }
  const orderId = req.query.token || req.body.orderId;
  const debtId = req.query.debtId || req.body.debtId;
  const userId = req.query.userId || (req.user && req.user.id);
  if (!orderId || !debtId || !userId) return res.status(400).json({ message: 'Faltan datos para capturar' });

  try {
    // token
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
    const tokenResp = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) {
      return res.status(500).json({ message: 'Error autenticando con PayPal', error: tokenData });
    }

    // capturar
    const capResp = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenData.access_token}`
      }
    });
    const capData = await capResp.json();
    if (!capResp.ok) {
      return res.status(500).json({ message: 'Error al capturar orden', error: capData });
    }

    // marcar pagado
    const debt = await Debt.findOne({ where: { id: debtId, user_id: userId } });
    if (!debt) return res.status(404).json({ message: 'Deuda no encontrada' });
    if (debt.status !== 'paid') {
      const { total } = computePayableAmount(debt);
      debt.status = 'paid';
      await debt.save();
      await Payment.create({
        debt_id: debt.id,
        amount: total,
        method: 'paypal',
        reference: `pp:${orderId}`,
        paid_at: new Date()
      });
    }

    // si viene de return_url, redirigir al home (evita 404 en SPA)
    if (req.method === 'GET') {
      const frontUrlRaw = process.env.FRONTEND_URL || 'http://localhost:5173';
      const frontUrl = frontUrlRaw ? frontUrlRaw.replace(/\/+$/, '') : 'http://localhost:5173';
      return res.redirect(`${frontUrl}/`);
    }
    res.json({ ok: true, data: capData });
  } catch (err) {
    console.error('[paypal] error al capturar:', err);
    res.status(500).json({ message: 'Error al capturar orden PayPal', error: err.message });
  }
}

module.exports = { listPayments, createPayPalOrder, capturePayPalOrder };
