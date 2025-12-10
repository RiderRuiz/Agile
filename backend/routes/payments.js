const express = require('express');
const router = express.Router();
const auth = require('../middlewares/authMiddleware');
const { listPayments, createPayPalOrder, capturePayPalOrder } = require('../controllers/paymentController');

// Rutas publicas para PayPal (no requieren JWT)
router.post('/paypal/capture', capturePayPalOrder);
router.get('/paypal/capture', capturePayPalOrder);

// Rutas protegidas
router.use(auth);
router.get('/', listPayments);
router.post('/paypal/order', createPayPalOrder);

module.exports = router;
