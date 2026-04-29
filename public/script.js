const teachers = [
  {
    id: "valentina",
    name: "Valentina Ruiz",
    specialty: "Pilates reformer",
    bio: "Clases enfocadas en postura, movilidad y trabajo consciente para todos los niveles.",
    schedule: {
      1: ["08:00", "09:00", "18:00", "19:00"],
      3: ["10:00", "11:00", "17:00", "18:00"],
      5: ["08:30", "09:30", "16:00", "17:00"]
    }
  },
  {
    id: "martin",
    name: "Martin Sosa",
    specialty: "Pilates mat",
    bio: "Ideal para fortalecer el core y mejorar flexibilidad con clases dinamicas y progresivas.",
    schedule: {
      2: ["07:30", "08:30", "18:30", "19:30"],
      4: ["09:00", "10:00", "17:30", "18:30"],
      6: ["10:00", "11:00", "12:00"]
    }
  },
  {
    id: "camila",
    name: "Camila Herrera",
    specialty: "Pilates terapeutico",
    bio: "Sesiones suaves y personalizadas para recuperacion, bienestar y control corporal.",
    schedule: {
      1: ["14:00", "15:00", "16:00"],
      2: ["11:00", "12:00", "13:00"],
      4: ["14:00", "15:00", "16:00"],
      5: ["11:30", "12:30", "13:30"]
    }
  }
];

const teacherSelect = document.getElementById("teacher-select");
const dateInput = document.getElementById("date-input");
const teacherSpotlight = document.getElementById("teacher-spotlight");
const slotsGrid = document.getElementById("slots-grid");
const selectionSummary = document.getElementById("selection-summary");
const statusBanner = document.getElementById("status-banner");
const bookButton = document.getElementById("book-button");
const bookingsList = document.getElementById("bookings-list");
const bookingTemplate = document.getElementById("booking-card-template");
const accountTitle = document.getElementById("account-title");
const accountDetail = document.getElementById("account-detail");
const viewerBadge = document.getElementById("viewer-badge");
const bookingsHeading = document.getElementById("bookings-heading");
const logoutButton = document.getElementById("logout-button");
const registerForm = document.getElementById("register-form");
const loginForm = document.getElementById("login-form");
const authView = document.getElementById("auth-view");
const appView = document.getElementById("app-view");

const state = {
  selectedTeacherId: teachers[0].id,
  selectedDate: "",
  selectedTime: "",
  bookings: [],
  slotCounts: [],
  loading: false,
  me: null,
  apiEnabled: true
};

function setStatus(message, type = "") {
  statusBanner.textContent = message;
  statusBanner.className = "status-banner";

  if (!message) {
    return;
  }

  statusBanner.classList.add("is-visible");

  if (type) {
    statusBanner.classList.add(type);
  }
}

function clearStatus() {
  setStatus("");
}

function setDefaultDate() {
  const today = new Date();
  const offsetDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
  state.selectedDate = offsetDate.toISOString().split("T")[0];
  dateInput.value = state.selectedDate;
  dateInput.min = state.selectedDate;
}

function renderTeacherOptions() {
  teacherSelect.innerHTML = teachers
    .map((teacher) => `<option value="${teacher.id}">${teacher.name}</option>`)
    .join("");
  teacherSelect.value = state.selectedTeacherId;
}

function getSelectedTeacher() {
  return teachers.find((teacher) => teacher.id === state.selectedTeacherId);
}

function getDaySlots(teacher, dateString) {
  const dayIndex = new Date(`${dateString}T12:00:00`).getDay();
  return teacher.schedule[dayIndex] ?? [];
}

function isSlotBooked(teacherId, date, time) {
  return state.bookings.some((booking) =>
    booking.teacherId === teacherId &&
    booking.date === date &&
    booking.time === time &&
    booking.userId === state.me?.id
  );
}

function getSlotCount(teacherId, date, time) {
  const slotInfo = state.slotCounts.find((slot) =>
    slot.teacherId === teacherId &&
    slot.date === date &&
    slot.time === time
  );

  return slotInfo?.count ?? 0;
}

function renderTeacherSpotlight() {
  const teacher = getSelectedTeacher();
  const availableDays = Object.keys(teacher.schedule)
    .map(Number)
    .sort((a, b) => a - b)
    .map(dayName)
    .join(", ");

  teacherSpotlight.innerHTML = `
    <div class="teacher-topline">
      <h3>${teacher.name}</h3>
      <span class="teacher-badge">${teacher.specialty}</span>
    </div>
    <p>${teacher.bio}</p>
    <p><strong>Dias disponibles:</strong> ${availableDays}</p>
  `;
}

function renderSlots() {
  const teacher = getSelectedTeacher();
  const slots = getDaySlots(teacher, state.selectedDate);

  if (!slots.length) {
    slotsGrid.innerHTML = `<p class="empty-state">Ese profesor no atiende en la fecha elegida. Proba con otro dia.</p>`;
    state.selectedTime = "";
    updateSelectionSummary();
    return;
  }

  slotsGrid.innerHTML = slots
    .map((time) => {
      const alreadyBooked = isSlotBooked(teacher.id, state.selectedDate, time);
      const slotCount = getSlotCount(teacher.id, state.selectedDate, time);
      const full = slotCount >= 5;
      const selected = state.selectedTime === time;
      const classes = [
        "slot-button",
        selected ? "selected" : "",
        (alreadyBooked || full) ? "disabled" : ""
      ].filter(Boolean).join(" ");

      return `
        <button
          type="button"
          class="${classes}"
          data-time="${time}"
          ${(alreadyBooked || full || state.loading) ? "disabled" : ""}
        >
          <strong>${time}</strong>
          <span>${alreadyBooked ? "Ya reservado por ti" : full ? "Completo" : `${slotCount}/5 reservados`}</span>
        </button>
      `;
    })
    .join("");
}

function updateSelectionSummary() {
  const teacher = getSelectedTeacher();
  const hasSelection = Boolean(state.selectedDate && state.selectedTime);

  if (!state.me) {
    selectionSummary.innerHTML = `<p>Inicia sesion para poder confirmar turnos.</p>`;
    bookButton.disabled = true;
    return;
  }

  if (!hasSelection) {
    selectionSummary.innerHTML = `<p>Selecciona un horario disponible para ver el resumen de tu clase.</p>`;
    bookButton.disabled = true;
    return;
  }

  selectionSummary.innerHTML = `
    <p class="summary-highlight">Turno listo para confirmar</p>
    <p><strong>Profesor:</strong> ${teacher.name}</p>
    <p><strong>Fecha:</strong> ${formatDate(state.selectedDate)}</p>
    <p><strong>Horario:</strong> ${state.selectedTime}</p>
    <p><strong>Especialidad:</strong> ${teacher.specialty}</p>
  `;
  bookButton.disabled = state.loading || !state.apiEnabled;
}

function renderSession() {
  if (!state.me) {
    accountTitle.textContent = "Sin sesion iniciada";
    accountDetail.textContent = "Registrate o inicia sesion para empezar a reservar.";
    viewerBadge.textContent = "Vista publica";
    bookingsHeading.textContent = "Reservas guardadas";
    logoutButton.hidden = true;
    authView.hidden = false;
    appView.hidden = true;
    return;
  }

  accountTitle.textContent = state.me.role === "admin"
    ? `${state.me.name} (admin)`
    : state.me.name;
  accountDetail.textContent = state.me.role === "admin"
    ? "Tienes permisos de administrador y puedes ver todas las reservas."
    : "Puedes reservar y gestionar solo tus propios turnos.";
  viewerBadge.textContent = state.me.role === "admin" ? "Vista admin" : "Vista usuario";
  bookingsHeading.textContent = state.me.role === "admin" ? "Todas las reservas" : "Mis reservas";
  logoutButton.hidden = false;
  authView.hidden = true;
  appView.hidden = false;
}

function renderBookings() {
  bookingsList.innerHTML = "";

  if (!state.bookings.length) {
    bookingsList.innerHTML = `<p class="empty-state">Todavia no hay reservas guardadas.</p>`;
    return;
  }

  const sortedBookings = [...state.bookings].sort((a, b) =>
    `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)
  );

  sortedBookings.forEach((booking) => {
    const fragment = bookingTemplate.content.cloneNode(true);
    fragment.querySelector("h3").textContent = booking.teacherName;

    const ownerPart = booking.userName
      ? ` · ${booking.userName}${booking.userEmail ? ` (${booking.userEmail})` : ""}`
      : "";

    fragment.querySelector(".booking-meta").textContent =
      `${formatDate(booking.date)} a las ${booking.time} · ${booking.specialty}${ownerPart}`;

    fragment.querySelector("button").addEventListener("click", async () => {
      await deleteBooking(booking.id);
    });

    bookingsList.appendChild(fragment);
  });
}

function setLoading(isLoading) {
  state.loading = isLoading;
  teacherSelect.disabled = isLoading;
  dateInput.disabled = isLoading;
  bookButton.disabled = isLoading || !state.selectedTime || !state.apiEnabled || !state.me;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    },
    ...options
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error || "Ocurrio un error inesperado.");
  }

  return payload;
}

async function loadSession() {
  try {
    const payload = await request("/api/me");
    state.me = payload.user;
  } catch (error) {
    state.me = null;
  }

  renderSession();
  updateSelectionSummary();
}

async function fetchBookings() {
  if (!state.me) {
    state.bookings = [];
    state.apiEnabled = true;
    renderBookings();
    renderSlots();
    updateSelectionSummary();
    return;
  }

  setLoading(true);
  setStatus("Conectando con Neon...");

  try {
    const payload = await request("/api/bookings");
    state.bookings = payload.bookings;
    state.slotCounts = payload.slotCounts || [];
    state.apiEnabled = true;
    clearStatus();
  } catch (error) {
    state.bookings = [];
    state.slotCounts = [];
    state.apiEnabled = false;
    setStatus(error.message, "is-error");
  } finally {
    setLoading(false);
    renderBookings();
    renderSlots();
    updateSelectionSummary();
  }
}

async function createBooking() {
  if (!state.selectedDate || !state.selectedTime || !state.apiEnabled || !state.me) {
    return;
  }

  const teacher = getSelectedTeacher();

  if (isSlotBooked(teacher.id, state.selectedDate, state.selectedTime)) {
    setStatus("Ya tienes una reserva para ese horario. Elige otro turno disponible.", "is-error");
    renderSlots();
    updateSelectionSummary();
    return;
  }

  if (getSlotCount(teacher.id, state.selectedDate, state.selectedTime) >= 5) {
    setStatus("Ese horario ya alcanzo el cupo maximo de 5 personas.", "is-error");
    renderSlots();
    updateSelectionSummary();
    return;
  }

  setLoading(true);
  setStatus("Guardando turno en Neon...");

  try {
    await request("/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        teacherId: teacher.id,
        teacherName: teacher.name,
        specialty: teacher.specialty,
        date: state.selectedDate,
        time: state.selectedTime
      })
    });

    state.selectedTime = "";
    await fetchBookings();
    setStatus("Turno confirmado y sincronizado con Neon.", "is-success");
  } catch (error) {
    setLoading(false);
    setStatus(error.message, "is-error");
    renderSlots();
    updateSelectionSummary();
  }
}

async function deleteBooking(id) {
  setLoading(true);
  setStatus("Cancelando turno...");

  try {
    await request(`/api/bookings/${id}`, { method: "DELETE" });
    await fetchBookings();
    setStatus("Turno cancelado correctamente.", "is-success");
  } catch (error) {
    setLoading(false);
    setStatus(error.message, "is-error");
  }
}

async function handleRegister(event) {
  event.preventDefault();
  clearStatus();

  const formData = new FormData(registerForm);
  const payload = Object.fromEntries(formData.entries());

  try {
    await request("/api/register", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    registerForm.reset();
    await loadSession();
    await fetchBookings();
    setStatus("Cuenta creada e inicio de sesion correcto.", "is-success");
  } catch (error) {
    const message = error.message === "Credenciales invalidas."
      ? "Credenciales invalidas. Si recreaste las tablas o cambiaste la configuracion, vuelve a registrarte."
      : error.message;
    setStatus(message, "is-error");
  }
}

async function handleLogin(event) {
  event.preventDefault();
  clearStatus();

  const formData = new FormData(loginForm);
  const payload = Object.fromEntries(formData.entries());

  try {
    await request("/api/login", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    loginForm.reset();
    await loadSession();
    await fetchBookings();
    setStatus("Sesion iniciada correctamente.", "is-success");
  } catch (error) {
    setStatus(error.message, "is-error");
  }
}

async function handleLogout() {
  try {
    await request("/api/logout", { method: "POST" });
  } catch (error) {
    // Ignorar para limpiar estado local igualmente.
  }

  state.me = null;
  state.selectedTime = "";
  state.bookings = [];
  state.slotCounts = [];
  renderSession();
  renderBookings();
  renderSlots();
  updateSelectionSummary();
  setStatus("Sesion cerrada.", "is-success");
}

function formatDate(dateString) {
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(new Date(`${dateString}T12:00:00`));
}

function dayName(dayIndex) {
  const baseDate = new Date(`2026-05-${String(dayIndex + 3).padStart(2, "0")}T12:00:00`);
  return new Intl.DateTimeFormat("es-AR", { weekday: "long" }).format(baseDate);
}

teacherSelect.addEventListener("change", (event) => {
  state.selectedTeacherId = event.target.value;
  state.selectedTime = "";
  renderTeacherSpotlight();
  renderSlots();
  updateSelectionSummary();
});

dateInput.addEventListener("change", (event) => {
  state.selectedDate = event.target.value;
  state.selectedTime = "";
  renderSlots();
  updateSelectionSummary();
});

slotsGrid.addEventListener("click", (event) => {
  const button = event.target.closest(".slot-button");

  if (!button || button.disabled) {
    return;
  }

  clearStatus();
  state.selectedTime = button.dataset.time;
  renderSlots();
  updateSelectionSummary();
});

bookButton.addEventListener("click", createBooking);
registerForm.addEventListener("submit", handleRegister);
loginForm.addEventListener("submit", handleLogin);
logoutButton.addEventListener("click", handleLogout);

async function init() {
  renderTeacherOptions();
  setDefaultDate();
  renderTeacherSpotlight();
  renderSlots();
  renderSession();
  updateSelectionSummary();
  renderBookings();
  await loadSession();
  await fetchBookings();
}

init();
