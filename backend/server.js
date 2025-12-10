require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { sequelize } = require('./models');
const authRoutes = require('./routes/auth');
const debtRoutes = require('./routes/debts');
const reminderRoutes = require('./routes/reminders');
const loanRoutes = require('./routes/loans');
const paymentRoutes = require('./routes/payments');
const { scheduleTodayNotifier } = require('./notifier');

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use('/api/auth', authRoutes);
app.use('/api/debts', debtRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/payments', paymentRoutes);

// Ruta de retorno de MP para evitar 404 en back_urls
app.get('/mp-return', (req, res) => {
  const status = req.query.status || 'sin_estado';
  res.send(`Estado de pago: ${status}`);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await sequelize.authenticate();
    console.log('Conexion con Postgres establecida.');
    await sequelize.sync({ alter: true });
    scheduleTodayNotifier();
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  } catch (err) {
    console.error('Error al iniciar servidor:', err);
    process.exit(1);
  }
})();
