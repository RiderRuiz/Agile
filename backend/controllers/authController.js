const jwt = require('jsonwebtoken');
const { User } = require('../models');
require('dotenv').config();

function buildAuthPayload(user) {
  const token = jwt.sign(
    { id: user.id, email: user.email, phone: user.phone || null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone }
  };
}

async function register(req, res) {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = (req.body.password || '').trim();
    const phone = (req.body.phone || '').trim();
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Nombre, email y contrasena requeridos' });
    }
    const existing = await User.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({ message: 'Email ya registrado' });
    }
    await User.create({ name, email, password, phone: phone || null });
    res.status(201).json({ message: 'Cuenta creada. Ahora inicia sesiИn con tus credenciales.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al registrar usuario', error: err.message });
  }
}

async function login(req, res) {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = (req.body.password || '').trim();
    if (!email || !password) {
      return res.status(400).json({ message: 'Email y contrasena requeridos' });
    }
    const user = await User.findOne({ where: { email } });
    if (!user || !user.verifyPassword(password)) {
      return res.status(401).json({ message: 'Credenciales invalidas' });
    }
    res.json(buildAuthPayload(user));
  } catch (err) {
    res.status(500).json({ message: 'Error en servidor', error: err.message });
  }
}

module.exports = { register, login };
