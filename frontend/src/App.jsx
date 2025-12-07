import React, { useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

const API = import.meta.env?.VITE_API_URL || "http://localhost:4000";
const ONE_WEEK_MS = 1000 * 60 * 60 * 24 * 7;
const PAYMENT_METHODS = [
  { value: "tarjeta", label: "Tarjeta" },
  { value: "yape", label: "Yape" },
  { value: "plin", label: "Plin" },
  { value: "transferencia", label: "Transferencia" },
  { value: "efectivo", label: "Efectivo" },
  { value: "otro", label: "Otro" }
];
const INITIAL_AUTH_FORM = { name: "", email: "", password: "", phone: "" };
const INITIAL_LOAN_FORM = {
  name: "",
  principal: "",
  interest: "",
  installmentsCount: "",
  frequencyDays: "30",
  startDate: "",
  notes: ""
};

function formatCurrency(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString("es-PE", { style: "currency", currency: "PEN" }) : "-";
}

function formatDateDisplay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${day}/${month}/${year}`;
}

function normalizeInterestPercent(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return numeric <= 1 ? numeric * 100 : numeric;
}

function buildNotificationText(item) {
  const base = item.loanName ? `${item.loanName} - ${item.name}` : item.name;
  return `${base} vence el ${formatDateDisplay(item.due_date)}`;
}

function getDueState(dueDate, status) {
  if (status === "paid") return "paid";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return "pending";
  const diff = due.getTime() - today.getTime();
  if (diff < 0) return "overdue";
  if (diff <= ONE_WEEK_MS) return "week";
  return "pending";
}

function shouldShowInstallment(inst, showAll) {
  if (showAll) return true;
  const due = new Date(inst.due_date);
  if (Number.isNaN(due.getTime())) return true;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const sameMonth = due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth();
  const previousUnpaid = due < startOfMonth && inst.status !== "paid";
  return sameMonth || previousUnpaid;
}

function generateInstallmentPlan(form) {
  const principal = Number(form.principal);
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new Error("Ingresa un monto total valido.");
  }

  const normalizedPercent = normalizeInterestPercent(form.interest);
  if (normalizedPercent === null) {
    throw new Error("Ingresa una tasa valida (ej. 12 o 0.12).");
  }

  const installmentsCount = parseInt(form.installmentsCount, 10);
  if (!Number.isFinite(installmentsCount) || installmentsCount <= 0) {
    throw new Error("Ingresa el numero de cuotas.");
  }

  const frequencyDays = parseInt(form.frequencyDays, 10);
  if (!Number.isFinite(frequencyDays) || frequencyDays <= 0) {
    throw new Error("Los dias entre cuotas deben ser mayores a cero.");
  }

  const startDate = form.startDate ? new Date(`${form.startDate}T00:00:00`) : null;
  if (!startDate || Number.isNaN(startDate.getTime())) {
    throw new Error("Selecciona la fecha de inicio.");
  }

  const interestRate = normalizedPercent / 100;
  let payment;

  if (interestRate > 0) {
    const pow = Math.pow(1 + interestRate, installmentsCount);
    payment = principal * (interestRate * pow) / (pow - 1);
  } else {
    payment = principal / installmentsCount;
  }

  const schedule = [];
  let remaining = principal;

  for (let i = 1; i <= installmentsCount; i++) {
    const interestPortion = interestRate > 0 ? remaining * interestRate : 0;
    let installmentAmount = interestRate > 0 ? payment : principal / installmentsCount;

    if (i === installmentsCount) {
      installmentAmount = remaining + interestPortion;
    }

    installmentAmount = Math.max(0, Math.round(installmentAmount * 100) / 100);

    const dueDate = new Date(startDate);
    dueDate.setDate(dueDate.getDate() + frequencyDays * i);

    schedule.push({
      name: `Cuota ${i}`,
      amount: installmentAmount,
      due_date: dueDate.toISOString().split("T")[0],
      installment_number: i
    });

    remaining = Math.max(0, remaining - (installmentAmount - interestPortion));
  }

  const totalScheduled = schedule.reduce((sum, inst) => sum + inst.amount, 0);
  const expectedTotal = interestRate > 0 ? payment * installmentsCount : principal;
  const diff = Math.round((expectedTotal - totalScheduled) * 100) / 100;
  if (schedule.length > 0 && Math.abs(diff) >= 0.01) {
    schedule[schedule.length - 1].amount = Math.max(0, Math.round((schedule[schedule.length - 1].amount + diff) * 100) / 100);
  }

  return { schedule, normalizedPercent };
}

export default function App() {
  const [authMode, setAuthMode] = useState("login");
  const [form, setForm] = useState(INITIAL_AUTH_FORM);
  const [authError, setAuthError] = useState(null);
  const [authFeedback, setAuthFeedback] = useState(null);
  const [appMessage, setAppMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loans, setLoans] = useState([]);
  const [overdueDebts, setOverdueDebts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loanForm, setLoanForm] = useState(INITIAL_LOAN_FORM);
  const [installmentList, setInstallmentList] = useState([]);
  const [showAllDebts, setShowAllDebts] = useState(false);
  const [paymentModal, setPaymentModal] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState("tarjeta");
  const [paymentReference, setPaymentReference] = useState("");

  const isAuthenticated = Boolean(token);

  const handleFormChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleLoanFormChange = (field, value) => {
    setLoanForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleInterestBlur = () => {
    const raw = Number(loanForm.interest);
    if (!Number.isFinite(raw) || raw <= 0) return;
    if (raw > 1) {
      const converted = Math.round((raw / 10) * 1000) / 1000;
      setLoanForm((prev) => ({ ...prev, interest: converted.toString() }));
      setAppMessage({
        type: "info",
        text: `La tasa ingresada se ajustó automáticamente a ${converted}%`
      });
    }
  };

  const resetState = () => {
    setUser(null);
    setToken(null);
    setLoans([]);
    setOverdueDebts([]);
    setNotifications([]);
    setPayments([]);
    setLoanForm(INITIAL_LOAN_FORM);
    setInstallmentList([]);
    setForm(INITIAL_AUTH_FORM);
    setAuthMode("login");
    setAuthFeedback(null);
    setAppMessage(null);
  };

  const loadData = async (authToken) => {
    const activeToken = authToken || token;
    if (!activeToken) return;

    try {
      const headers = { Authorization: `Bearer ${activeToken}` };
      const [loansRes, debtsRes, paymentsRes] = await Promise.all([
        fetch(`${API}/api/loans`, { headers }),
        fetch(`${API}/api/debts`, { headers }),
        fetch(`${API}/api/payments`, { headers })
      ]);

      if (!loansRes.ok) {
        const err = await loansRes.json().catch(() => ({}));
        throw new Error(err.message || "No se pudieron cargar los prestamos.");
      }
      if (!debtsRes.ok) {
        const err = await debtsRes.json().catch(() => ({}));
        throw new Error(err.message || "No se pudieron cargar las deudas.");
      }

      if (!paymentsRes.ok) {
        const err = await paymentsRes.json().catch(() => ({}));
        throw new Error(err.message || "No se pudieron cargar los pagos.");
      }

      const loansData = await loansRes.json();
      const debtsData = await debtsRes.json();
      const paymentsData = await paymentsRes.json();
      const singles = debtsData.filter((d) => !d.loan_id);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const overdueLoanInstallments = loansData.flatMap((loan) =>
        (loan.installments || [])
          .filter((inst) => inst.status !== "paid" && new Date(inst.due_date) < today)
          .map((inst) => ({ ...inst, loanName: loan.name }))
      );

      const overdueSingles = singles
        .filter((item) => item.status !== "paid" && new Date(item.due_date) < today)
        .map((item) => ({ ...item, loanName: null }));

      setLoans(loansData);
      setOverdueDebts([...overdueLoanInstallments, ...overdueSingles]);
      setPayments(paymentsData);

      const upcoming = [
        ...loansData.flatMap((loan) =>
          (loan.installments || []).map((inst) => ({ ...inst, loanName: loan.name }))
        ),
        ...singles.map((item) => ({ ...item, loanName: null }))
      ].filter(
        (inst) =>
          inst.status !== "paid" &&
          new Date(inst.due_date) <= new Date(Date.now() + ONE_WEEK_MS)
      );

      setNotifications(
        upcoming.map((inst) => ({
          id: `${inst.loan_id || "extra"}-${inst.id}`,
          text: buildNotificationText(inst)
        }))
      );
    } catch (err) {
      setAppMessage({ type: "danger", text: err.message });
    }
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setAuthError(null);
    setAuthFeedback(null);
    setAppMessage(null);

    try {
      const payload = {
        email: form.email.trim(),
        password: form.password.trim()
      };
      if (authMode === "register") {
        payload.name = form.name.trim();
        payload.phone = form.phone.trim();
      }

      const res = await fetch(`${API}/api/auth/${authMode === "login" ? "login" : "register"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || "No se pudo autenticar.");
      }

      if (authMode === "login") {
        setUser(data.user);
        setToken(data.token);
        setForm(INITIAL_AUTH_FORM);
        setAuthFeedback(null);
        setAppMessage({
          type: "success",
          text: "Bienvenido de nuevo."
        });
        await loadData(data.token);
      } else {
        setForm((prev) => ({ ...INITIAL_AUTH_FORM, email: payload.email }));
        setAuthMode("login");
        setAuthFeedback({
          type: "success",
          text: data.message || "Cuenta creada. Ahora inicia sesión con tus credenciales."
        });
        setAppMessage(null);
      }
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    resetState();
  };

  const handleGenerateSchedule = () => {
    setAppMessage(null);
    try {
      const { schedule } = generateInstallmentPlan(loanForm);
      setInstallmentList(schedule);
      setAppMessage({
        type: "info",
        text: `Se generaron ${schedule.length} cuotas automaticamente.`
      });
    } catch (err) {
      setAppMessage({ type: "danger", text: err.message });
    }
  };

  const handleClearSchedule = () => {
    setInstallmentList([]);
  };

  const downloadLoanSchedule = (loan) => {
    if (!loan || !Array.isArray(loan.installments) || loan.installments.length === 0) {
      setAppMessage({
        type: "warning",
        text: "No hay cuotas para descargar en este prestamo."
      });
      return;
    }

    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(`Cronograma - ${loan.name}`, 14, 18);

    const totalVisible = loan.installments.length;
    const totalOriginal = loan.total_installments ?? (totalVisible + (loan.overdue_count || 0));
    const summaryLines = [
      `Monto total: ${formatCurrency(loan.principal_amount || 0)}`,
      `Cuotas totales: ${totalOriginal}`,
      `Cuotas pendientes sin mora: ${loan.visible_pending}`,
      loan.overdue_count ? `Cuotas en mora: ${loan.overdue_count}` : null,
      loan.next_due ? `Proximo vencimiento: ${formatDateDisplay(loan.next_due)}` : null
    ].filter(Boolean);

    doc.setFontSize(11);
    summaryLines.forEach((line, index) => {
      doc.text(line, 14, 26 + index * 6);
    });

    autoTable(doc, {
      startY: 26 + summaryLines.length * 6 + 6,
      head: [["Cuota", "Vencimiento", "Monto", "Estado"]],
      body: loan.installments.map((inst) => [
        inst.name,
        formatDateDisplay(inst.due_date),
        formatCurrency(inst.amount),
        inst.status === "paid" ? "Pagada" : "Pendiente"
      ])
    });

    const slug = loan.name
      ? loan.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      : `prestamo-${loan.id}`;
    doc.save(`cronograma-${slug || "agile"}.pdf`);
  };

  const downloadPaymentReceipt = (payment) => {
    if (!payment) return;
    const methodLabel = payment.method
      ? payment.method.charAt(0).toUpperCase() + payment.method.slice(1)
      : "No especificado";
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("Comprobante de pago", 14, 18);

    const detailLines = [
      payment.loan_name ? `Prestamo: ${payment.loan_name}` : null,
      `Cuota: ${payment.debt_name}`,
      `Fecha de vencimiento: ${formatDateDisplay(payment.due_date)}`,
      `Fecha de pago: ${formatDateDisplay(payment.paid_at)}`,
      `Monto pagado: ${formatCurrency(payment.amount)}`,
      `Medio: ${methodLabel}`
    ].filter(Boolean);

    doc.setFontSize(11);
    detailLines.forEach((line, index) => {
      doc.text(line, 14, 26 + index * 6);
    });

    autoTable(doc, {
      startY: 26 + detailLines.length * 6 + 6,
      head: [["Descripcion", "Valor"]],
      body: [
        ["Prestamo", payment.loan_name || "Deuda suelta"],
        ["Cuota", payment.debt_name || "-"],
        ["Monto", formatCurrency(payment.amount)],
        ["Medio", methodLabel],
        ["Vencimiento", formatDateDisplay(payment.due_date)],
        ["Pago registrado", formatDateDisplay(payment.paid_at)]
      ]
    });

    doc.save(`comprobante-pago-${payment.id}.pdf`);
  };

  const handleCreateLoan = async (event) => {
    event.preventDefault();
    if (!token) return;

    setAppMessage(null);

    const name = loanForm.name.trim();
    if (!name) {
      setAppMessage({ type: "danger", text: "Ingresa un nombre para el prestamo." });
      return;
    }

    let schedule = installmentList;
    let normalizedPercent = normalizeInterestPercent(loanForm.interest);
    if (normalizedPercent === null) {
      setAppMessage({ type: "danger", text: "Ingresa una tasa valida (ej. 12 o 0.12)." });
      return;
    }

    if (schedule.length === 0) {
      try {
        const plan = generateInstallmentPlan(loanForm);
        schedule = plan.schedule;
        normalizedPercent = plan.normalizedPercent;
        setInstallmentList(plan.schedule);
      } catch (err) {
        setAppMessage({ type: "danger", text: err.message });
        return;
      }
    }

    if (schedule.length === 0) {
      setAppMessage({ type: "danger", text: "Agrega o genera al menos una cuota." });
      return;
    }

    const principalAmount = Number(loanForm.principal);
    if (!Number.isFinite(principalAmount) || principalAmount <= 0) {
      setAppMessage({ type: "danger", text: "Ingresa un monto total valido." });
      return;
    }

    try {
      const payload = {
        name,
        principal_amount: principalAmount,
        interest_rate: normalizedPercent || 0,
        start_date: loanForm.startDate || null,
        notes: loanForm.notes ? loanForm.notes.trim() : null,
        installments: schedule.map((inst, index) => ({
          id: inst.id,
          name: inst.name || `Cuota ${index + 1}`,
          amount: Number(inst.amount),
          due_date: inst.due_date,
          installment_number: inst.installment_number || index + 1
        }))
      };

      const res = await fetch(`${API}/api/loans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || "No se pudo crear el prestamo.");
      }

      setAppMessage({ type: "success", text: "Prestamo creado correctamente." });
      setLoanForm(INITIAL_LOAN_FORM);
      setInstallmentList([]);
      await loadData();
    } catch (err) {
      setAppMessage({ type: "danger", text: err.message });
    }
  };

  const markPaid = async (id, options = {}) => {
    if (!token) return false;
    if (options.loanHasOverdue) {
      setAppMessage({
        type: "warning",
        text: "Debes regularizar primero las cuotas en mora de este préstamo."
      });
      return false;
    }
    const payload = {};
    if (options.method) payload.method = options.method;
    if (options.reference) payload.reference = options.reference;
    try {
      const res = await fetch(`${API}/api/debts/${id}/pay`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || "No se pudo registrar el pago.");
      }
      if (data.payment) {
        setPayments((prev) => [
          {
            id: data.payment.id,
            amount: data.payment.amount,
            paid_at: data.payment.paid_at,
            debt_id: data.payment.debt_id,
            debt_name: data.payment.debt_name,
            due_date: data.payment.due_date,
            loan_name: data.payment.loan_name,
            method: data.payment.method,
            reference: data.payment.reference
          },
          ...prev
        ]);
      }
      await loadData();
      setAppMessage({ type: "success", text: "Pago registrado correctamente." });
      return true;
    } catch (err) {
      setAppMessage({ type: "danger", text: err.message });
      return false;
    }
  };

  const openPaymentModal = (debt, options = {}) => {
    if (options.loanHasOverdue) {
      setAppMessage({
        type: "warning",
        text: "Debes regularizar primero las cuotas en mora de este préstamo."
      });
      return;
    }
    setPaymentModal({
      id: debt.id,
      name: debt.name,
      amount: debt.amount,
      due_date: debt.due_date,
      loanName: options.loanName || null
    });
    setPaymentMethod("tarjeta");
    setPaymentReference("");
  };

  const confirmPayment = async () => {
    if (!paymentModal) return;
    const ok = await markPaid(paymentModal.id, {
      method: paymentMethod,
      reference: paymentReference
    });
    if (ok) {
      setPaymentModal(null);
      setPaymentReference("");
    }
  };

  const overdueByLoan = useMemo(() => {
    const map = new Map();
    overdueDebts
      .filter((item) => item.loan_id)
      .forEach((item) => {
        if (!map.has(item.loan_id)) {
          map.set(item.loan_id, new Set());
        }
        map.get(item.loan_id).add(item.id);
      });
    return map;
  }, [overdueDebts]);

  const pendingLoans = useMemo(() => {
    return (loans || []).map((loan) => {
      const loanOverdueIds = overdueByLoan.get(loan.id) || new Set();
      const filteredInstallments = (loan.installments || []).filter(
        (inst) => !loanOverdueIds.has(inst.id) && shouldShowInstallment(inst, showAllDebts)
      );
      const visiblePending = filteredInstallments.filter((inst) => inst.status !== "paid").length;
      return {
        ...loan,
        installments: loan.installments || [],
        visible_installments: filteredInstallments,
        hasOverdue: loanOverdueIds.size > 0,
        visible_pending: visiblePending,
        overdue_count: loanOverdueIds.size
      };
    });
  }, [loans, overdueByLoan, showAllDebts]);
  const totalOverdue = useMemo(() => overdueDebts.length, [overdueDebts]);

  if (!isAuthenticated) {
    return (
      <div className="auth-wrapper">
        <div className="card auth-card shadow-lg border-0">
          <div className="card-body p-4 p-md-5">
            <h2 className="mb-3 text-center">
              {authMode === "login" ? "Iniciar sesion" : "Crear cuenta"}
            </h2>
            <p className="text-muted text-center mb-4">
              Gestiona tus prestamos y deudas desde un solo lugar.
            </p>
                {authFeedback && (
                  <div className={`alert alert-${authFeedback.type}`} role="alert">
                    {authFeedback.text}
                  </div>
                )}
                {authError && (
                  <div className="alert alert-danger" role="alert">
                    {authError}
                  </div>
                )}
            <form onSubmit={handleAuthSubmit} className="needs-validation" noValidate>
              {authMode === "register" && (
                <div className="mb-3">
                  <label className="form-label">Nombre completo</label>
                  <input
                    type="text"
                    className="form-control"
                    value={form.name}
                    onChange={(e) => handleFormChange("name", e.target.value)}
                    placeholder="Tu nombre"
                    required
                  />
                </div>
              )}
              {authMode === "register" && (
                <div className="mb-3">
                  <label className="form-label">Telefono (para notificaciones)</label>
                  <input
                    type="tel"
                    className="form-control"
                    value={form.phone}
                    onChange={(e) => handleFormChange("phone", e.target.value)}
                    placeholder="+51 999 999 999"
                  />
                </div>
              )}
              <div className="mb-3">
                <label className="form-label">Email</label>
                <input
                  type="email"
                  className="form-control"
                  value={form.email}
                  onChange={(e) => handleFormChange("email", e.target.value)}
                  placeholder="tucorreo@ejemplo.com"
                  required
                />
              </div>
              <div className="mb-3">
                <label className="form-label">Contrasena</label>
                <input
                  type="password"
                  className="form-control"
                  value={form.password}
                  onChange={(e) => handleFormChange("password", e.target.value)}
                  placeholder="********"
                  required
                />
              </div>
              <button className="btn btn-primary w-100" type="submit" disabled={loading}>
                {loading ? "Procesando..." : authMode === "login" ? "Iniciar sesion" : "Registrarme"}
              </button>
            </form>
            <div className="text-center mt-4">
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => {
                    setAuthMode(authMode === "login" ? "register" : "login");
                    setAuthError(null);
                    setAuthFeedback(null);
                  }}
                >
                {authMode === "login"
                  ? "¿No tienes cuenta? Regístrate"
                  : "¿Ya tienes cuenta? Inicia sesión"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-vh-100 bg-body-tertiary">
      <nav className="navbar navbar-expand-lg navbar-dark bg-primary shadow-sm">
        <div className="container">
          <span className="navbar-brand fw-semibold">Agile Deudas</span>
          <div className="ms-auto d-flex align-items-center gap-3">
            <span className="text-white-50 small text-uppercase">Hola, {user?.name}</span>
            <button className="btn btn-outline-light btn-sm" onClick={handleLogout}>
              Cerrar sesion
            </button>
          </div>
        </div>
      </nav>

      <div className="container py-4 py-lg-5">
        {appMessage && (
          <div className={`alert alert-${appMessage.type}`} role="alert">
            {appMessage.text}
          </div>
        )}

        <div className="row g-4">
          <div className="col-lg-8">
            <div className="card section-card mb-4">
              <div className="card-header">
                <h5 className="mb-0">Nuevo prestamo</h5>
              </div>
              <div className="card-body">
                <form onSubmit={handleCreateLoan} className="row g-3">
                  <div className="col-md-6">
                    <label className="form-label">Nombre</label>
                    <input
                      type="text"
                      className="form-control"
                      value={loanForm.name}
                      onChange={(e) => handleLoanFormChange("name", e.target.value)}
                      placeholder="Prestamo personal"
                      required
                    />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Monto total</label>
                    <input
                      type="number"
                      className="form-control"
                      value={loanForm.principal}
                      onChange={(e) => handleLoanFormChange("principal", e.target.value)}
                      placeholder="5000"
                      min="0"
                    />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Tasa (%)</label>
                    <input
                      type="number"
                      className="form-control"
                      value={loanForm.interest}
                      onChange={(e) => handleLoanFormChange("interest", e.target.value)}
                      onBlur={handleInterestBlur}
                      placeholder="12 o 0.12"
                      min="0"
                      step="0.01"
                    />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Numero de cuotas</label>
                    <input
                      type="number"
                      className="form-control"
                      value={loanForm.installmentsCount}
                      onChange={(e) => handleLoanFormChange("installmentsCount", e.target.value)}
                      placeholder="12"
                      min="1"
                    />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Dias entre cuotas</label>
                    <input
                      type="number"
                      className="form-control"
                      value={loanForm.frequencyDays}
                      onChange={(e) => handleLoanFormChange("frequencyDays", e.target.value)}
                      placeholder="30"
                      min="1"
                    />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Fecha de inicio</label>
                    <input
                      type="date"
                      className="form-control"
                      value={loanForm.startDate}
                      onChange={(e) => handleLoanFormChange("startDate", e.target.value)}
                    />
                  </div>
                  <div className="col-md-8">
                    <label className="form-label">Notas</label>
                    <input
                      type="text"
                      className="form-control"
                      value={loanForm.notes}
                      onChange={(e) => handleLoanFormChange("notes", e.target.value)}
                      placeholder="Informacion adicional"
                    />
                  </div>
                  <div className="d-flex flex-wrap gap-2">
                    <button type="button" className="btn btn-outline-secondary" onClick={handleGenerateSchedule}>
                      Generar cuotas automaticas
                    </button>
                    <button type="button" className="btn btn-outline-danger" onClick={handleClearSchedule}>
                      Limpiar cuotas
                    </button>
                    <button type="submit" className="btn btn-primary ms-auto">
                      Crear prestamo
                    </button>
                  </div>
                </form>

                {installmentList.length > 0 && (
                  <div className="table-responsive mt-4">
                    <table className="table table-sm table-striped">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Vencimiento</th>
                          <th>Monto</th>
                        </tr>
                      </thead>
                      <tbody>
                        {installmentList.map((inst) => (
                          <tr key={inst.installment_number}>
                            <td>{inst.name}</td>
                            <td>{formatDateDisplay(inst.due_date)}</td>
                            <td>{formatCurrency(inst.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="card section-card">
              <div className="card-header d-flex align-items-center justify-content-between gap-2">
                <h5 className="mb-0">Prestamos activos</h5>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  onClick={() => setShowAllDebts((prev) => !prev)}
                >
                  {showAllDebts ? "Ver solo mes actual" : "Ver todas las cuotas"}
                </button>
              </div>
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-center mb-3 text-muted small">
                  <span>
                    {showAllDebts
                      ? "Mostrando todas las cuotas."
                      : "Mostrando cuotas del mes y pendientes de meses previos."}
                  </span>
                </div>
                {pendingLoans.length === 0 ? (
                  <p className="text-muted mb-0">No tienes prestamos registrados.</p>
                ) : (
                  pendingLoans.map((loan) => (
                    <div key={loan.id} className="mb-4">
                    <div className="d-flex flex-wrap align-items-start justify-content-between gap-3">
                      <div>
                        <h6 className="mb-1">{loan.name}</h6>
                          <span className="badge bg-light text-dark badge-status">
                            Cuotas pendientes: {loan.visible_pending}
                          </span>
                        {loan.hasOverdue && (
                          <div className="text-danger small mt-2">
                            Este préstamo tiene {loan.overdue_count} cuota(s) en mora. Regularízalas desde la sección inferior.
                          </div>
                        )}
                      </div>
                        <div className="d-flex flex-column align-items-end gap-2">
                          <div className="text-end text-secondary small">
                            <div>Monto original: {formatCurrency(loan.principal_amount)}</div>
                            <div>Proximo vencimiento: {loan.next_due ? formatDateDisplay(loan.next_due) : "-"}</div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-success"
                            onClick={() => downloadLoanSchedule(loan)}
                          >
                            Descargar cronograma
                          </button>
                        </div>
                      </div>

                      <div className="table-responsive mt-3">
                        <table className="table table-borderless align-middle mb-0">
                          <thead className="table-light">
                            <tr>
                              <th>Cuota</th>
                              <th>Vencimiento</th>
                              <th>Monto</th>
                              <th>Estado</th>
                              <th className="text-end">Acciones</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(loan.visible_installments || loan.installments || []).map((inst) => {
                              const dueState = getDueState(inst.due_date, inst.status);
                              const rowClass =
                                dueState === "overdue"
                                  ? "row-overdue"
                                  : dueState === "week"
                                    ? "row-due-soon"
                                    : "";
                              const badgeClass =
                                dueState === "overdue"
                                  ? "bg-danger text-white"
                                  : dueState === "week"
                                    ? "bg-warning text-dark"
                                    : inst.status === "paid"
                                      ? "bg-success"
                                      : "bg-secondary-subtle text-secondary";
                              return (
                                <tr key={inst.id} className={rowClass}>
                                  <td>{inst.name}</td>
                                  <td>{formatDateDisplay(inst.due_date)}</td>
                                  <td>{formatCurrency(inst.amount)}</td>
                                  <td>
                                    <span className={`badge badge-status ${badgeClass}`}>
                                      {inst.status === "paid" ? "Pagada" : "Pendiente"}
                                    </span>
                                  </td>
                                  <td className="text-end">
                                    {inst.status !== "paid" && (
                                      <button
                                        className="btn btn-sm btn-outline-primary"
                                        onClick={() =>
                                          openPaymentModal(inst, {
                                            loanHasOverdue: loan.hasOverdue,
                                            loanName: loan.name
                                          })
                                        }
                                        disabled={loan.hasOverdue}
                                      >
                                        Registrar pago
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="card section-card mt-4">
              <div className="card-header d-flex justify-content-between align-items-center">
                <h5 className="mb-0">Deudas con mora (5%)</h5>
                <span className="badge bg-danger-subtle text-danger">
                  Pendientes: {totalOverdue}
                </span>
              </div>
              <div className="card-body">
                {overdueDebts.length === 0 ? (
                  <p className="text-muted mb-0">No tienes deudas vencidas con mora.</p>
                ) : (
                  <div className="table-responsive">
                    <table className="table table-striped">
                      <thead>
                        <tr>
                          <th>Origen</th>
                          <th>Deuda</th>
                          <th>Vencimiento</th>
                          <th>Monto base</th>
                          <th>Mora (5%)</th>
                          <th>Total con mora</th>
                          <th className="text-end">Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overdueDebts.map((debt) => {
                          const baseAmount = Number(debt.amount) || 0;
                          const penaltyAmount = Math.round(baseAmount * 0.05 * 100) / 100;
                          const totalWithPenalty = Math.round((baseAmount + penaltyAmount) * 100) / 100;
                          return (
                            <tr key={`${debt.loanName || "solo"}-${debt.id}`} className="row-overdue">
                              <td>{debt.loanName || "Deuda suelta"}</td>
                              <td>{debt.name}</td>
                              <td>{formatDateDisplay(debt.due_date)}</td>
                              <td>{formatCurrency(baseAmount)}</td>
                              <td>{formatCurrency(penaltyAmount)}</td>
                              <td>{formatCurrency(totalWithPenalty)}</td>
                              <td className="text-end">
                                <button
                                  className="btn btn-sm btn-outline-primary"
                                  onClick={() =>
                                    openPaymentModal(debt, { loanName: debt.loanName || null })
                                  }
                                >
                                  Registrar pago
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="col-lg-4">
            <div className="card section-card">
              <div className="card-header">
                <h5 className="mb-0">Notificaciones</h5>
              </div>
              <div className="card-body">
                {notifications.length === 0 ? (
                  <p className="text-muted mb-0">No hay notificaciones pendientes.</p>
                ) : (
                  <ul className="list-unstyled mb-0 notifications-list">
                    {notifications.map((item) => (
                      <li key={item.id} className="d-flex gap-3">
                        <span className="badge bg-primary-subtle text-primary rounded-pill mt-1">•</span>
                        <span>{item.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="card section-card mt-4">
              <div className="card-header d-flex justify-content-between align-items-center">
                <h5 className="mb-0">Pagos registrados</h5>
                <span className="badge bg-secondary-subtle text-secondary">{payments.length}</span>
              </div>
              <div className="card-body">
                {payments.length === 0 ? (
                  <p className="text-muted mb-0">Aun no registras pagos.</p>
                ) : (
                  <div className="table-responsive">
                    <table className="table table-sm">
                      <thead>
                        <tr>
                          <th>Fecha pago</th>
                          <th>Cuota</th>
                          <th>Medio</th>
                          <th>Monto</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {payments.map((payment) => (
                          <tr key={payment.id}>
                            <td>{formatDateDisplay(payment.paid_at)}</td>
                            <td>
                              <div className="fw-semibold">{payment.debt_name}</div>
                              <div className="text-muted small">
                                {payment.loan_name || "Deuda suelta"}
                              </div>
                            </td>
                            <td className="text-capitalize">
                              {payment.method || "sin especificar"}
                              {payment.reference ? (
                                <div className="text-muted small">Ref: {payment.reference}</div>
                              ) : null}
                            </td>
                            <td>{formatCurrency(payment.amount)}</td>
                            <td className="text-end">
                              <button
                                className="btn btn-sm btn-outline-secondary"
                                onClick={() => downloadPaymentReceipt(payment)}
                              >
                                Comprobante
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {paymentModal && (
        <div className="payment-modal-overlay">
          <div className="payment-modal card shadow-lg">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start mb-3">
                <div>
                  <h5 className="mb-1">Registrar pago</h5>
                  <div className="text-muted small">
                    {paymentModal.loanName ? `${paymentModal.loanName} - ` : ""}
                    {paymentModal.name}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => setPaymentModal(null)}
                  aria-label="Cerrar modal de pago"
                >
                  X
                </button>
              </div>

              <div className="mb-3">
                <div className="fw-semibold">Monto: {formatCurrency(paymentModal.amount)}</div>
                <div className="text-muted small">
                  Vence: {formatDateDisplay(paymentModal.due_date)}
                </div>
              </div>

              <div className="mb-3">
                <label className="form-label">Medio de pago</label>
                <select
                  className="form-select"
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                >
                  {PAYMENT_METHODS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-4">
                <label className="form-label">Referencia (opcional)</label>
                <input
                  type="text"
                  className="form-control"
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  placeholder="Ultimos 4 de la tarjeta, codigo de operacion, etc."
                />
              </div>

              <div className="d-flex justify-content-end gap-2">
                <button type="button" className="btn btn-outline-secondary" onClick={() => setPaymentModal(null)}>
                  Cancelar
                </button>
                <button type="button" className="btn btn-primary" onClick={confirmPayment}>
                  Confirmar pago
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
