import React, { useState } from "react";

const API = import.meta.env?.VITE_API_URL || "http://localhost:4000";
const ONE_WEEK_MS = 1000 * 60 * 60 * 24 * 7;

function formatCurrency(amount) {
  const num = Number(amount);
  return Number.isNaN(num) ? "-" : num.toFixed(2);
}

function buildNotificationText(debt, loanName) {
  const base = loanName ? `${loanName} - ${debt.name}` : debt.name;
  return `${base} vence el ${debt.due_date}`;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function calculatePenalty(amount, rate = 0.05) {
  const base = Number(amount);
  if (!Number.isFinite(base) || base <= 0) {
    return 0;
  }
  return roundMoney(base * rate);
}

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function generateInstallmentsSchedule(form) {
  const principal = Number(form.principal);
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new Error("Ingresa un monto total valido");
  }

  const ratePerc = form.interest === "" ? 0 : Number(form.interest);
  if (!Number.isFinite(ratePerc)) {
    throw new Error("Ingresa una tasa valida (puede ser 0)");
  }

  const count = parseInt(form.installmentsCount, 10);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error("Ingresa el numero de cuotas");
  }

  if (!form.startDate) {
    throw new Error("Selecciona la fecha de inicio");
  }

  const frequency = parseInt(form.frequencyDays, 10);
  if (!Number.isFinite(frequency) || frequency <= 0) {
    throw new Error("Los dias entre cuotas deben ser mayores a cero");
  }

  const startDate = new Date(`${form.startDate}T00:00:00`);
  const rate = ratePerc / 100;
  let payment;

  if (rate > 0) {
    const pow = Math.pow(1 + rate, count);
    payment = principal * (rate * pow) / (pow - 1);
  } else {
    payment = principal / count;
  }

  let remaining = principal;
  const installments = [];

  for (let i = 1; i <= count; i++) {
    const interestPortion = rate > 0 ? remaining * rate : 0;
    let rawInstallment = rate > 0 ? payment : principal / count;

    if (i === count) {
      rawInstallment = remaining + interestPortion;
    }

    let installmentAmount = roundMoney(rawInstallment);
    if (installmentAmount < 0) {
      installmentAmount = 0;
    }

    const dueDate = new Date(startDate);
    dueDate.setDate(dueDate.getDate() + frequency * i);

    installments.push({
      name: `Cuota ${i}`,
      amount: installmentAmount,
      due_date: toISODate(dueDate),
      installment_number: i
    });

    const principalPortion = installmentAmount - interestPortion;
    remaining = Math.max(0, remaining - principalPortion);
  }

  const totalPaid = installments.reduce((sum, inst) => sum + inst.amount, 0);
  const expectedTotal = rate > 0 ? payment * count : principal;
  const diff = roundMoney(expectedTotal - totalPaid);
  if (installments.length > 0 && Math.abs(diff) >= 0.01) {
    const updated = roundMoney(installments[installments.length - 1].amount + diff);
    installments[installments.length - 1].amount = updated < 0 ? 0 : updated;
  }

  return installments;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ email: "", password: "" });
  const [loans, setLoans] = useState([]);
  const [overdueDebts, setOverdueDebts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loanForm, setLoanForm] = useState({
    name: "",
    principal: "",
    interest: "",
    startDate: "",
    notes: "",
    installmentsCount: "",
    frequencyDays: "30"
  });
  const [installmentList, setInstallmentList] = useState([]);

  const resetSession = () => {
    setUser(null);
    setToken(null);
    setLoans([]);
    setOverdueDebts([]);
    setNotifications([]);
    setLoanForm({ name: "", principal: "", interest: "", startDate: "", notes: "", installmentsCount: "", frequencyDays: "30" });
    setInstallmentList([]);
  };

  const loadData = async (authToken) => {
    const currentToken = authToken || token;
    if (!currentToken) return;

    try {
      const [loansRes, debtsRes] = await Promise.all([
        fetch(`${API}/api/loans`, {
          headers: { Authorization: `Bearer ${currentToken}` }
        }),
        fetch(`${API}/api/debts`, {
          headers: { Authorization: `Bearer ${currentToken}` }
        })
      ]);

      if (!loansRes.ok) {
        const err = await loansRes.json().catch(() => ({}));
        throw new Error(err.message || "No se pudieron cargar los prestamos");
      }
      if (!debtsRes.ok) {
        const err = await debtsRes.json().catch(() => ({}));
        throw new Error(err.message || "No se pudieron cargar las deudas");
      }

      const loansData = await loansRes.json();
      const debtsData = await debtsRes.json();
      const singles = debtsData.filter((d) => !d.loan_id);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const overdueLoanInstallments = loansData.flatMap((loan) =>
        (loan.installments || [])
          .filter(
            (inst) => inst.status !== "paid" && new Date(inst.due_date) < today
          )
          .map((inst) => ({ ...inst, loanName: loan.name }))
      );

      const overdueSingles = singles
        .filter((item) => item.status !== "paid" && new Date(item.due_date) < today)
        .map((item) => ({ ...item, loanName: null }));

      setLoans(loansData);
      setOverdueDebts([...overdueLoanInstallments, ...overdueSingles]);

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
          text: buildNotificationText(inst, inst.loanName)
        }))
      );
    } catch (err) {
      console.error(err);
      alert(err.message || "Error al cargar los datos");
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || "Credenciales incorrectas");
      }
      const data = await res.json();
      setUser(data.user);
      setToken(data.token);
      await loadData(data.token);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const markPaid = async (id) => {
    if (!token) return;
    try {
      const res = await fetch(`${API}/api/debts/${id}/pay`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "No se pudo marcar la cuota como pagada");
      }
      await loadData();
    } catch (err) {
      alert(err.message || "Error al marcar pagado");
    }
  };

  const handleGenerateSchedule = () => {
    try {
      const schedule = generateInstallmentsSchedule(loanForm);
      setInstallmentList(schedule);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleClearSchedule = () => {
    setInstallmentList([]);
  };

  const handleCreateLoan = async (e) => {
    e.preventDefault();
    if (!token) return;

    if (!loanForm.name.trim()) {
      alert("Ingresa un nombre para el prestamo");
      return;
    }
    const parsedPrincipal = loanForm.principal ? Number(loanForm.principal) : null;
    if (loanForm.principal && Number.isNaN(parsedPrincipal)) {
      alert("El monto total del prestamo debe ser numerico");
      return;
    }

    const parsedInterest = loanForm.interest ? Number(loanForm.interest) : null;
    if (loanForm.interest && Number.isNaN(parsedInterest)) {
      alert("La tasa debe ser numerica");
      return;
    }

    let schedule = installmentList;
    if (schedule.length === 0) {
      try {
        schedule = generateInstallmentsSchedule(loanForm);
        setInstallmentList(schedule);
      } catch (err) {
        alert(err.message);
        return;
      }
    }

    if (schedule.length === 0) {
      alert("Agrega al menos una cuota");
      return;
    }

    const scheduleWithNumbers = schedule.map((inst, index) => ({
      name: inst.name,
      amount: Number(inst.amount),
      due_date: inst.due_date,
      installment_number: index + 1
    }));

    const payload = {
      name: loanForm.name.trim(),
      principal_amount: parsedPrincipal,
      interest_rate: parsedInterest,
      start_date: loanForm.startDate || null,
      notes: loanForm.notes ? loanForm.notes.trim() : null,
      installments: scheduleWithNumbers
    };

    try {
      const res = await fetch(`${API}/api/loans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "No se pudo crear el prestamo");
      }
      alert("Prestamo creado correctamente");
      setLoanForm({ name: "", principal: "", interest: "", startDate: "", notes: "", installmentsCount: "", frequencyDays: "30" });
      setInstallmentList([]);
      await loadData();
    } catch (err) {
      alert(err.message || "Error al crear el prestamo");
    }
  };

  if (!token) {
    return (
      <div style={{ maxWidth: 420, margin: "40px auto", padding: 20, border: "1px solid #ccc", borderRadius: 8 }}>
        <h2>Iniciar sesion</h2>
        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", marginBottom: 4 }}>Email</label>
            <input
              style={{ width: "100%", padding: 8 }}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="test@user.com"
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", marginBottom: 4 }}>Contrasena</label>
            <input
              type="password"
              style={{ width: "100%", padding: 8 }}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="password"
            />
          </div>
          <div>
            <button type="submit" style={{ padding: "8px 12px" }} disabled={loading}>
              {loading ? "Entrando..." : "Entrar"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  const penaltyRate = 0.05;
  const totalOverdue = overdueDebts.length;

  return (
    <div style={{ maxWidth: 1100, margin: "20px auto", display: "grid", gridTemplateColumns: "1fr 320px", gap: 20 }}>
      <div>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Dashboard - {user.name}</h2>
          <button onClick={resetSession}>Cerrar sesion</button>
        </header>

        <section style={{ marginTop: 18, padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
          <h3>Nuevo prestamo</h3>
          <form onSubmit={handleCreateLoan}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <label>
                <span>Nombre</span>
                <input
                  style={{ width: "100%", padding: 6, marginTop: 4 }}
                  value={loanForm.name}
                  onChange={(e) => setLoanForm({ ...loanForm, name: e.target.value })}
                  placeholder="Prestamo personal"
                />
              </label>
                <label>
                  <span>Monto total</span>
                  <input
                    type="number"
                    step="0.01"
                    style={{ width: "100%", padding: 6, marginTop: 4 }}
                    value={loanForm.principal}
                    onChange={(e) => setLoanForm({ ...loanForm, principal: e.target.value })}
                    placeholder="12000"
                  />
                </label>
                <label>
                  <span>Tasa (%)</span>
                  <input
                    type="number"
                    step="0.01"
                    style={{ width: "100%", padding: 6, marginTop: 4 }}
                    value={loanForm.interest}
                    onChange={(e) => setLoanForm({ ...loanForm, interest: e.target.value })}
                    placeholder="12"
                  />
                </label>
                <label>
                  <span>Inicio</span>
                  <input
                    type="date"
                    style={{ width: "100%", padding: 6, marginTop: 4 }}
                    value={loanForm.startDate}
                    onChange={(e) => setLoanForm({ ...loanForm, startDate: e.target.value })}
                  />
                </label>
                <label>
                  <span>Numero de cuotas</span>
                  <input
                    type="number"
                    style={{ width: "100%", padding: 6, marginTop: 4 }}
                    value={loanForm.installmentsCount}
                    onChange={(e) => setLoanForm({ ...loanForm, installmentsCount: e.target.value })}
                    placeholder="12"
                  />
                </label>
                <label>
                  <span>Dias entre cuotas</span>
                  <input
                    type="number"
                    style={{ width: "100%", padding: 6, marginTop: 4 }}
                    value={loanForm.frequencyDays}
                    onChange={(e) => setLoanForm({ ...loanForm, frequencyDays: e.target.value })}
                    placeholder="30"
                  />
                </label>
              </div>
              <label style={{ display: "block", marginTop: 12 }}>
                <span>Notas</span>
                <textarea
                  style={{ width: "100%", padding: 6, marginTop: 4 }}
                rows={2}
                value={loanForm.notes}
                onChange={(e) => setLoanForm({ ...loanForm, notes: e.target.value })}
                placeholder="Informacion adicional"
              />
              </label>

              <div style={{ marginTop: 16, borderTop: "1px solid #eee", paddingTop: 12 }}>
                <strong>Cuotas</strong>
                <div style={{ marginTop: 8, marginBottom: 8 }}>
                  <button type="button" onClick={handleGenerateSchedule} style={{ padding: "6px 10px" }}>
                    Generar cuotas automaticas
                  </button>
                  <div style={{ fontSize: 12, color: "#555", marginTop: 6 }}>
                    Las fechas se calculan sumando los dias indicados a la fecha de inicio (la primera cuota se programa despues del primer intervalo).
                  </div>
                </div>
                {installmentList.length > 0 ? (
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: 6 }}>Cuota</th>
                        <th style={{ textAlign: "left", padding: 6 }}>Vencimiento</th>
                        <th style={{ textAlign: "left", padding: 6 }}>Monto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {installmentList.map((inst, idx) => (
                        <tr key={`${inst.due_date}-${idx}`} style={{ borderTop: "1px solid #eee" }}>
                          <td style={{ padding: 8 }}>{inst.name || `Cuota ${idx + 1}`}</td>
                          <td style={{ padding: 8 }}>{inst.due_date}</td>
                          <td style={{ padding: 8 }}>S/ {formatCurrency(inst.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ marginTop: 12, fontSize: 14, color: "#555" }}>
                    Genera las cuotas o crea tu propio cronograma modificando los datos arriba.
                  </div>
                )}

                {installmentList.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <button type="button" onClick={handleClearSchedule} style={{ padding: "6px 10px" }}>
                      Limpiar cuotas
                    </button>
                  </div>
                )}
            </div>

          <div style={{ marginTop: 12 }}>
            <button type="submit" style={{ padding: "8px 12px" }}>
              Crear prestamo
            </button>
          </div>
          </form>
        </section>

        <section style={{ marginTop: 18 }}>
          <h3>Prestamos activos</h3>
          {loans.length === 0 ? (
            <p>No tienes prestamos registrados.</p>
          ) : (
            loans.map((loan) => (
              <div key={loan.id} style={{ border: "1px solid #e0e0e0", borderRadius: 8, padding: 14, marginBottom: 16 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "space-between" }}>
                  <div>
                    <strong>{loan.name}</strong>
                    <div style={{ fontSize: 14, color: "#555" }}>
                      Cuotas pendientes: {loan.pending_installments} / {loan.total_installments ?? loan.installments.length}
                    </div>
                  </div>
                  <div style={{ fontSize: 14, color: "#555" }}>
                    Monto original: S/ {loan.principal_amount ? formatCurrency(loan.principal_amount) : "-"}
                    <br />
                    Proximo vencimiento: {loan.next_due || "-"}
                  </div>
                </div>

                <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: 6 }}>Cuota</th>
                      <th style={{ textAlign: "left", padding: 6 }}>Vencimiento</th>
                      <th style={{ textAlign: "left", padding: 6 }}>Monto</th>
                      <th style={{ textAlign: "left", padding: 6 }}>Estado</th>
                      <th style={{ textAlign: "left", padding: 6 }}>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(loan.installments || []).map((inst) => (
                      <tr key={inst.id} style={{ borderTop: "1px solid #eee" }}>
                        <td style={{ padding: 8 }}>{inst.name}</td>
                        <td style={{ padding: 8 }}>{inst.due_date}</td>
                        <td style={{ padding: 8 }}>S/ {formatCurrency(inst.amount)}</td>
                        <td style={{ padding: 8 }}>{inst.status === "paid" ? "Pagada" : "Pendiente"}</td>
                        <td style={{ padding: 8 }}>
                          {inst.status !== "paid" && (
                            <button onClick={() => markPaid(inst.id)}>Marcar pagada</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </section>

        <section style={{ marginTop: 18 }}>
          <h3>Deudas con mora (5%)</h3>
          {overdueDebts.length === 0 ? (
            <p>No tienes deudas vencidas con mora.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: 6 }}>Origen</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Deuda</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Vencimiento</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Monto base</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Mora (5%)</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Total con mora</th>
                  <th style={{ textAlign: "left", padding: 6 }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {overdueDebts.map((debt) => {
                  const baseAmount = Number(debt.amount) || 0;
                  const penaltyAmount = calculatePenalty(baseAmount, penaltyRate);
                  const totalWithPenalty = roundMoney(baseAmount + penaltyAmount);
                  return (
                    <tr key={debt.id} style={{ borderTop: "1px solid #eee" }}>
                      <td style={{ padding: 8 }}>{debt.loanName || "Deuda suelta"}</td>
                      <td style={{ padding: 8 }}>{debt.name}</td>
                      <td style={{ padding: 8 }}>{debt.due_date}</td>
                      <td style={{ padding: 8 }}>S/ {formatCurrency(baseAmount)}</td>
                      <td style={{ padding: 8 }}>S/ {formatCurrency(penaltyAmount)}</td>
                      <td style={{ padding: 8 }}>S/ {formatCurrency(totalWithPenalty)}</td>
                      <td style={{ padding: 8 }}>
                        <button onClick={() => markPaid(debt.id)}>Marcar pagada</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div style={{ marginTop: 6, fontSize: 14, color: "#555" }}>
            Pendientes vencidas: {totalOverdue}
          </div>
        </section>
      </div>

      <aside style={{ borderLeft: "1px solid #ddd", paddingLeft: 16 }}>
        <h3>Notificaciones</h3>
        {notifications.length === 0 ? (
          <p>No hay notificaciones</p>
        ) : (
          <ul>
            {notifications.map((n) => (
              <li key={n.id} style={{ marginBottom: 8 }}>
                {n.text}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
