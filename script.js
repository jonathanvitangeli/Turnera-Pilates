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
    bio: "Ideal para fortalecer el core y mejorar flexibilidad con clases dinámicas y progresivas.",
    schedule: {
      2: ["07:30", "08:30", "18:30", "19:30"],
      4: ["09:00", "10:00", "17:30", "18:30"],
      6: ["10:00", "11:00", "12:00"]
    }
  },
  {
    id: "camila",
    name: "Camila Herrera",
    specialty: "Pilates terapéutico",
    bio: "Sesiones suaves y personalizadas para recuperación, bienestar y control corporal.",
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
const nextBookingTitle = document.getElementById("next-booking-title");
const nextBookingDetail = document.getElementById("next-booking-detail");

const state = {
  selectedTeacherId: teachers[0].id,
  selectedDate: "",
  selectedTime: "",
  bookings: [],
  loading: false,
  supabase: null,
  hasSupabaseConfig: false
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
    booking.teacherId === teacherId && booking.date === date && booking.time === time
  );
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
    <p><strong>Días disponibles:</strong> ${availableDays}</p>
  `;
}

function renderSlots() {
  const teacher = getSelectedTeacher();
  const slots = getDaySlots(teacher, state.selectedDate);

  if (!slots.length) {
    slotsGrid.innerHTML = `<p class="empty-state">Ese profesor no atiende en la fecha elegida. Probá con otro día.</p>`;
    state.selectedTime = "";
    updateSelectionSummary();
    return;
  }

  slotsGrid.innerHTML = slots
    .map((time) => {
      const alreadyBooked = isSlotBooked(teacher.id, state.selectedDate, time);
      const selected = state.selectedTime === time;
      const classes = [
        "slot-button",
        selected ? "selected" : "",
        alreadyBooked ? "disabled" : ""
      ].filter(Boolean).join(" ");

      return `
        <button
          type="button"
          class="${classes}"
          data-time="${time}"
          ${alreadyBooked || state.loading ? "disabled" : ""}
        >
          <strong>${time}</strong>
          <span>${alreadyBooked ? "Reservado" : "Disponible"}</span>
        </button>
      `;
    })
    .join("");
}

function updateSelectionSummary() {
  const teacher = getSelectedTeacher();
  const hasSelection = Boolean(state.selectedDate && state.selectedTime);

  if (!hasSelection) {
    selectionSummary.innerHTML = `<p>Seleccioná un horario disponible para ver el resumen de tu clase.</p>`;
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
  bookButton.disabled = state.loading || !state.hasSupabaseConfig;
}

function renderBookings() {
  bookingsList.innerHTML = "";

  if (!state.bookings.length) {
    bookingsList.innerHTML = `<p class="empty-state">Todavía no hay reservas guardadas.</p>`;
    updateNextBookingCard();
    return;
  }

  const sortedBookings = [...state.bookings].sort((a, b) =>
    `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)
  );

  sortedBookings.forEach((booking) => {
    const fragment = bookingTemplate.content.cloneNode(true);
    fragment.querySelector("h3").textContent = booking.teacherName;
    fragment.querySelector(".booking-meta").textContent =
      `${formatDate(booking.date)} a las ${booking.time} · ${booking.specialty}`;

    fragment.querySelector("button").addEventListener("click", async () => {
      await deleteBooking(booking.id);
    });

    bookingsList.appendChild(fragment);
  });

  updateNextBookingCard();
}

function updateNextBookingCard() {
  if (!state.bookings.length) {
    nextBookingTitle.textContent = "Todavía no hay turnos";
    nextBookingDetail.textContent = "Configurá Supabase y confirmá tu primera clase.";
    return;
  }

  const nextBooking = [...state.bookings].sort((a, b) =>
    `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)
  )[0];

  nextBookingTitle.textContent = `${nextBooking.teacherName} · ${nextBooking.time}`;
  nextBookingDetail.textContent = `${formatDate(nextBooking.date)} · ${nextBooking.specialty}`;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  teacherSelect.disabled = isLoading;
  dateInput.disabled = isLoading;
  bookButton.disabled = isLoading || !state.selectedTime || !state.hasSupabaseConfig;
}

async function fetchBookings() {
  if (!state.supabase) {
    setStatus("Completá tu archivo `.env` con `SUPABASE_URL` y `SUPABASE_ANON_KEY` para activar la base en Supabase.", "is-error");
    renderBookings();
    renderSlots();
    updateSelectionSummary();
    return;
  }

  setLoading(true);
  setStatus("Conectando con Supabase...");

  const { data, error } = await state.supabase
    .from("bookings")
    .select("id, teacher_id, teacher_name, specialty, booking_date, booking_time")
    .order("booking_date", { ascending: true })
    .order("booking_time", { ascending: true });

  setLoading(false);

  if (error) {
    setStatus(
      "No pude leer la tabla `bookings`. Revisá que hayas ejecutado `supabase-schema.sql` y que las políticas permitan `select`.",
      "is-error"
    );
    renderBookings();
    renderSlots();
    updateSelectionSummary();
    return;
  }

  state.bookings = data.map(mapBookingRow);
  clearStatus();
  renderBookings();
  renderSlots();
  updateSelectionSummary();
}

function mapBookingRow(row) {
  return {
    id: row.id,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    specialty: row.specialty,
    date: row.booking_date,
    time: row.booking_time
  };
}

async function createBooking() {
  if (!state.supabase || !state.selectedDate || !state.selectedTime) {
    return;
  }

  const teacher = getSelectedTeacher();

  if (isSlotBooked(teacher.id, state.selectedDate, state.selectedTime)) {
    setStatus("Ese horario ya fue reservado. Elegí otro turno disponible.", "is-error");
    renderSlots();
    updateSelectionSummary();
    return;
  }

  setLoading(true);
  setStatus("Guardando turno en Supabase...");

  const { error } = await state.supabase
    .from("bookings")
    .insert({
      teacher_id: teacher.id,
      teacher_name: teacher.name,
      specialty: teacher.specialty,
      booking_date: state.selectedDate,
      booking_time: state.selectedTime
    });

  if (error) {
    setLoading(false);
    setStatus(
      "No se pudo guardar el turno. Si el horario ya existe en la base, la restricción única va a bloquear el insert.",
      "is-error"
    );
    renderSlots();
    updateSelectionSummary();
    return;
  }

  state.selectedTime = "";
  await fetchBookings();
  setStatus("Turno confirmado y sincronizado con Supabase.", "is-success");
}

async function deleteBooking(id) {
  if (!state.supabase) {
    return;
  }

  setLoading(true);
  setStatus("Cancelando turno...");

  const { error } = await state.supabase
    .from("bookings")
    .delete()
    .eq("id", id);

  if (error) {
    setLoading(false);
    setStatus("No pude cancelar el turno en Supabase. Revisá la policy de `delete`.", "is-error");
    return;
  }

  await fetchBookings();
  setStatus("Turno cancelado correctamente.", "is-success");
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

bookButton.addEventListener("click", async () => {
  await createBooking();
});

async function loadSupabase() {
  const response = await fetch("/config");

  if (!response.ok) {
    throw new Error("No se pudo leer la configuración del servidor.");
  }

  const config = await response.json();
  const hasConfig = Boolean(config.url) && Boolean(config.anonKey);

  state.hasSupabaseConfig = hasConfig;
  state.supabase = hasConfig ? window.supabase.createClient(config.url, config.anonKey) : null;
}

async function init() {
  renderTeacherOptions();
  setDefaultDate();
  renderTeacherSpotlight();
  renderSlots();
  updateSelectionSummary();
  renderBookings();
  try {
    await loadSupabase();
  } catch (error) {
    setStatus("No pude cargar la configuración de Supabase desde el servidor local.", "is-error");
  }
  await fetchBookings();
}

init();
