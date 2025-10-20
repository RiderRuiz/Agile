const express = require('express');
const router = express.Router();
const auth = require('../middlewares/authMiddleware');
const { listPayments } = require('../controllers/paymentController');

router.use(auth);
router.get('/', listPayments);

module.exports = router;
