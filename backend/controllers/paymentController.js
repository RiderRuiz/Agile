const { Payment, Debt, Loan } = require('../models');

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

module.exports = { listPayments };
