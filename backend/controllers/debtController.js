const { Op } = require('sequelize');
const { Debt, Payment, Reminder, Loan } = require('../models');
const ALLOWED_METHODS = ['tarjeta', 'yape', 'plin', 'transferencia', 'efectivo', 'otro'];

async function listDebts(req, res) {
  try {
    const debts = await Debt.findAll({
      where: { user_id: req.user.id },
      include: [{ model: Loan, as: 'loan', attributes: ['id', 'name'] }],
      order: [['due_date','ASC']]
    });
    res.json(debts.map((debt) => debt.toJSON()));
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener deudas', error: err.message });
  }
}

async function payDebt(req, res) {
  try {
    const debtId = req.params.id;
    const { method, reference } = req.body || {};
    const debt = await Debt.findOne({
      where: { id: debtId, user_id: req.user.id },
      include: [{ model: Loan, as: 'loan', attributes: ['id', 'name'] }]
    });
    if (!debt) {
      return res.status(404).json({ message: 'Deuda no encontrada' });
    }

    if (debt.loan_id) {
      const overdueExists = await Debt.findOne({
        where: {
          user_id: req.user.id,
          loan_id: debt.loan_id,
          status: 'pending',
          due_date: { [Op.lt]: new Date() },
          id: { [Op.ne]: debt.id }
        },
        order: [['due_date', 'ASC']]
      });
      if (overdueExists) {
        return res.status(409).json({ message: 'Existen cuotas con mora pendientes. Debes pagarlas primero.' });
      }
    }

    let paymentMethod = null;
    if (method) {
      const normalized = String(method).trim().toLowerCase();
      if (!ALLOWED_METHODS.includes(normalized)) {
        return res.status(400).json({ message: 'Medio de pago no soportado' });
      }
      paymentMethod = normalized;
    }

    debt.status = 'paid';
    await debt.save();
    const payment = await Payment.create({
      debt_id: debt.id,
      amount: debt.amount,
      method: paymentMethod,
      reference: reference ? String(reference).trim() : null
    });
    res.json({
      message: 'Pago registrado correctamente',
      payment: {
        id: payment.id,
        amount: payment.amount,
        paid_at: payment.paid_at,
        debt_id: debt.id,
        debt_name: debt.name,
        due_date: debt.due_date,
        loan_id: debt.loan_id,
        loan_name: debt.loan ? debt.loan.name : null,
        method: payment.method,
        reference: payment.reference
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al registrar pago', error: err.message });
  }
}

module.exports = { listDebts, payDebt };
