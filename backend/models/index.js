const sequelize = require('../config/sequelize');
const User = require('./user');
const Debt = require('./debt');
const Loan = require('./loan');
const Payment = require('./payment');
const Reminder = require('./reminder');

User.hasMany(Loan, { foreignKey: 'user_id' });
Loan.belongsTo(User, { foreignKey: 'user_id' });

Loan.hasMany(Debt, { foreignKey: 'loan_id', as: 'installments' });
Debt.belongsTo(Loan, { foreignKey: 'loan_id', as: 'loan' });

User.hasMany(Debt, { foreignKey: 'user_id' });
Debt.belongsTo(User, { foreignKey: 'user_id' });

Debt.hasMany(Payment, { foreignKey: 'debt_id', as: 'payments' });
Payment.belongsTo(Debt, { foreignKey: 'debt_id', as: 'debt' });

module.exports = {
  sequelize,
  User,
  Debt,
  Loan,
  Payment,
  Reminder
};
