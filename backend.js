const crypto = require("crypto");
const { Pool } = require("pg");

const databaseUrl = process.env.DATABASE_URL || "";
const sessionSecret = process.env.SESSION_SECRET || "";

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false }
    })
  : null;

function sendJson(res, statusCode, payload, cookies = []) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8"
  };

  if (cookies.length) {
    headers["Set-Cookie"] = cookies;
  }

  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("El cuerpo de la solicitud no es JSON valido."));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [key, ...rest] = item.split("=");
        return [key, decodeURIComponent(rest.join("="))];
      })
  );
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, sessionSecret, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString("hex"));
    });
  });
}

function hashPasswordWithSalt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString("hex"));
    });
  });
}

async function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await hashPasswordWithSalt(password, salt);
  return `${salt}:${hash}`;
}

async function verifyPassword(password, storedHash) {
  if (storedHash.includes(":")) {
    const [salt, savedHash] = storedHash.split(":");
    const candidateHash = await hashPasswordWithSalt(password, salt);
    return crypto.timingSafeEqual(
      Buffer.from(candidateHash, "hex"),
      Buffer.from(savedHash, "hex")
    );
  }

  const legacyHash = await hashPassword(password);
  return crypto.timingSafeEqual(
    Buffer.from(legacyHash, "hex"),
    Buffer.from(storedHash, "hex")
  );
}

function setSessionCookie(token) {
  return `session_token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;
}

function clearSessionCookie() {
  return "session_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
}

function getSchemaHelpMessage(error, action) {
  const details = String(error?.message || "");

  if (
    details.includes("column") ||
    details.includes("does not exist") ||
    details.includes("relation") ||
    details.includes("violates not-null constraint") ||
    details.includes("constraint") ||
    error?.code === "42703"
  ) {
    return `No se pudo ${action} porque la base parece estar con un esquema viejo o incompleto. Vuelve a ejecutar neon-schema.sql en Neon.`;
  }

  return null;
}

function requireServerConfig(res) {
  if (!pool) {
    sendJson(res, 500, {
      error: "Falta DATABASE_URL en las variables de entorno para conectarse a Neon."
    });
    return false;
  }

  if (!sessionSecret) {
    sendJson(res, 500, {
      error: "Falta SESSION_SECRET en las variables de entorno."
    });
    return false;
  }

  return true;
}

async function getCurrentUser(req) {
  if (!pool || !sessionSecret) {
    return null;
  }

  const cookies = parseCookies(req);
  const token = cookies.session_token;

  if (!token) {
    return null;
  }

  const result = await pool.query(
    `
      select u.id, u.name, u.email, u.role
      from public.sessions s
      join public.users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()
      limit 1
    `,
    [hashToken(token)]
  );

  return result.rows[0] || null;
}

function normalizeDateValue(value) {
  if (!value) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function mapBookingRow(row) {
  return {
    id: row.id,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    specialty: row.specialty,
    date: normalizeDateValue(row.booking_date),
    time: row.booking_time,
    slotCount: Number(row.slot_count || 0),
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email
  };
}

function mapPaymentRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    packageName: row.package_name,
    classCount: Number(row.class_count || 0),
    amount: Number(row.amount || 0),
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

async function getUserCredits(userId) {
  const paymentsResult = await pool.query(
    `
      select coalesce(sum(class_count), 0)::int as total_paid_classes
      from public.payments
      where user_id = $1 and payment_status = 'approved'
    `,
    [userId]
  );

  const bookingsResult = await pool.query(
    `
      select count(*)::int as total_booked_classes
      from public.bookings
      where user_id = $1
    `,
    [userId]
  );

  const totalPaidClasses = Number(paymentsResult.rows[0]?.total_paid_classes || 0);
  const totalBookedClasses = Number(bookingsResult.rows[0]?.total_booked_classes || 0);

  return {
    totalPaidClasses,
    totalBookedClasses,
    availableClasses: Math.max(totalPaidClasses - totalBookedClasses, 0)
  };
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `
      insert into public.sessions (user_id, token_hash, expires_at)
      values ($1, $2, now() + interval '7 days')
    `,
    [userId, hashToken(token)]
  );
  return token;
}

async function handleRegister(req, res) {
  if (!requireServerConfig(res)) {
    return;
  }

  try {
    const body = await readBody(req);
    const { name, email, password } = body;

    if (!name || !email || !password || String(password).length < 6) {
      sendJson(res, 400, {
        error: "Nombre, email y contrasena de al menos 6 caracteres son obligatorios."
      });
      return;
    }

    const passwordHash = await createPasswordHash(password);
    const countResult = await pool.query("select count(*)::int as total from public.users");
    const role = countResult.rows[0].total === 0 ? "admin" : "user";
    const result = await pool.query(
      `
        insert into public.users (name, email, password_hash, role)
        values ($1, lower($2), $3, $4)
        returning id, name, email, role
      `,
      [name, email, passwordHash, role]
    );

    const user = result.rows[0];
    const token = await createSession(user.id);
    sendJson(res, 201, { user }, [setSessionCookie(token)]);
  } catch (error) {
    if (error.code === "23505") {
      sendJson(res, 409, { error: "Ya existe una cuenta con ese email." });
      return;
    }

    sendJson(res, 500, { error: "No se pudo crear la cuenta." });
  }
}

async function handleLogin(req, res) {
  if (!requireServerConfig(res)) {
    return;
  }

  try {
    const body = await readBody(req);
    const { email, password } = body;

    if (!email || !password) {
      sendJson(res, 400, { error: "Email y contrasena son obligatorios." });
      return;
    }

    const result = await pool.query(
      `
        select id, name, email, role, password_hash
        from public.users
        where email = lower($1)
        limit 1
      `,
      [email]
    );

    const user = result.rows[0];
    if (!user) {
      sendJson(res, 401, { error: "Credenciales invalidas." });
      return;
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      sendJson(res, 401, { error: "Credenciales invalidas." });
      return;
    }

    const token = await createSession(user.id);
    delete user.password_hash;
    sendJson(res, 200, { user }, [setSessionCookie(token)]);
  } catch (error) {
    sendJson(res, 500, { error: "No se pudo iniciar sesion." });
  }
}

async function handleLogout(req, res) {
  if (!requireServerConfig(res)) {
    return;
  }

  try {
    const cookies = parseCookies(req);
    if (cookies.session_token) {
      await pool.query(
        "delete from public.sessions where token_hash = $1",
        [hashToken(cookies.session_token)]
      );
    }
  } catch (error) {
  }

  sendJson(res, 200, { ok: true }, [clearSessionCookie()]);
}

async function handleMe(req, res) {
  if (!requireServerConfig(res)) {
    return;
  }

  try {
    const user = await getCurrentUser(req);
    sendJson(res, 200, { user });
  } catch (error) {
    sendJson(res, 500, { error: "No se pudo validar la sesion." });
  }
}

async function listBookings(req, res) {
  if (!requireServerConfig(res)) {
    return;
  }

  try {
    const user = await getCurrentUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Inicia sesion para ver reservas." });
      return;
    }

    const isAdmin = user.role === "admin";
    const slotCountsResult = await pool.query(
      `
        select teacher_id, booking_date, booking_time, count(*)::int as slot_count
        from public.bookings
        group by teacher_id, booking_date, booking_time
      `
    );

    const result = await pool.query(
      `
        select
          b.id,
          b.user_id,
          b.teacher_id,
          b.teacher_name,
          b.specialty,
          b.booking_date,
          b.booking_time,
          counts.slot_count,
          u.name as user_name,
          u.email as user_email
        from public.bookings b
        join public.users u on u.id = b.user_id
        join (
          select teacher_id, booking_date, booking_time, count(*)::int as slot_count
          from public.bookings
          group by teacher_id, booking_date, booking_time
        ) counts
          on counts.teacher_id = b.teacher_id
         and counts.booking_date = b.booking_date
         and counts.booking_time = b.booking_time
        where ($1::text = 'admin' or b.user_id = $2)
        order by b.booking_date asc, b.booking_time asc
      `,
      [user.role, user.id]
    );

    const credits = isAdmin
      ? null
      : await getUserCredits(user.id);

    sendJson(res, 200, {
      bookings: result.rows.map((row) => {
        const booking = mapBookingRow(row);
        if (!isAdmin) {
          delete booking.userEmail;
        }
        return booking;
      }),
      slotCounts: slotCountsResult.rows.map((row) => ({
        teacherId: row.teacher_id,
        date: normalizeDateValue(row.booking_date),
        time: row.booking_time,
        count: Number(row.slot_count || 0)
      })),
      credits
    });
  } catch (error) {
    const schemaMessage = getSchemaHelpMessage(error, "leer las reservas");
    sendJson(res, 500, {
      error: schemaMessage || "No pude leer la tabla bookings. Revisa que hayas ejecutado neon-schema.sql en Neon."
    });
  }
}

async function createBooking(req, res) {
  if (!requireServerConfig(res)) {
    return;
  }

  try {
    const user = await getCurrentUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Inicia sesion para reservar." });
      return;
    }

    const credits = await getUserCredits(user.id);
    if (credits.availableClasses <= 0) {
      sendJson(res, 409, {
        error: "No tienes clases pagadas disponibles. Registra un pago antes de reservar."
      });
      return;
    }

    const body = await readBody(req);
    const { teacherId, teacherName, specialty, date, time } = body;

    if (!teacherId || !teacherName || !specialty || !date || !time) {
      sendJson(res, 400, { error: "Faltan datos para crear la reserva." });
      return;
    }

    const capacityResult = await pool.query(
      `
        select count(*)::int as total
        from public.bookings
        where teacher_id = $1 and booking_date = $2 and booking_time = $3
      `,
      [teacherId, date, time]
    );

    if (capacityResult.rows[0].total >= 5) {
      sendJson(res, 409, { error: "Ese horario ya alcanzo el cupo maximo de 5 personas." });
      return;
    }

    const result = await pool.query(
      `
        insert into public.bookings (
          user_id, teacher_id, teacher_name, specialty, booking_date, booking_time
        )
        values ($1, $2, $3, $4, $5, $6)
        returning id, user_id, teacher_id, teacher_name, specialty, booking_date, booking_time
      `,
      [user.id, teacherId, teacherName, specialty, date, time]
    );

    sendJson(res, 201, {
      booking: mapBookingRow({
        ...result.rows[0],
        slot_count: capacityResult.rows[0].total + 1,
        user_name: user.name,
        user_email: user.email
      })
    });
  } catch (error) {
    if (error.code === "23505") {
      sendJson(res, 409, { error: "Ya tienes una reserva para ese mismo horario." });
      return;
    }

    const schemaMessage = getSchemaHelpMessage(error, "guardar el turno");
    sendJson(res, 500, { error: schemaMessage || "No se pudo guardar el turno en Neon." });
  }
}

async function deleteBooking(req, res, id) {
  if (!requireServerConfig(res)) {
    return;
  }

  try {
    const user = await getCurrentUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Inicia sesion para cancelar reservas." });
      return;
    }

    const result = await pool.query(
      `
        delete from public.bookings
        where id = $1 and ($2::text = 'admin' or user_id = $3)
        returning id
      `,
      [id, user.role, user.id]
    );

    if (!result.rowCount) {
      sendJson(res, 404, {
        error: "No encontre la reserva o no tienes permisos para cancelarla."
      });
      return;
    }

    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { error: "No se pudo cancelar el turno en Neon." });
  }
}

async function listPayments(req, res) {
  if (!requireServerConfig(res)) {
    return;
  }

  try {
    const user = await getCurrentUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Inicia sesion para ver pagos." });
      return;
    }

    const isAdmin = user.role === "admin";
    const result = await pool.query(
      `
        select
          p.id,
          p.user_id,
          p.package_name,
          p.class_count,
          p.amount,
          p.payment_method,
          p.payment_status,
          p.created_at,
          u.name as user_name,
          u.email as user_email
        from public.payments p
        join public.users u on u.id = p.user_id
        where ($1::text = 'admin' or p.user_id = $2)
        order by p.created_at desc
      `,
      [user.role, user.id]
    );

    sendJson(res, 200, {
      payments: result.rows.map((row) => {
        const payment = mapPaymentRow(row);
        if (!isAdmin) {
          delete payment.userEmail;
        }
        return payment;
      })
    });
  } catch (error) {
    const schemaMessage = getSchemaHelpMessage(error, "leer los pagos");
    sendJson(res, 500, {
      error: schemaMessage || error.message || "No pude leer los pagos. Revisa que hayas ejecutado neon-schema.sql en Neon."
    });
  }
}

async function createPayment(req, res) {
  if (!requireServerConfig(res)) {
    return;
  }

  try {
    const user = await getCurrentUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Inicia sesion para registrar pagos." });
      return;
    }

    const body = await readBody(req);
    const { packageName, classCount, amount } = body;

    if (!packageName || !Number.isInteger(classCount) || classCount <= 0 || typeof amount !== "number" || amount < 0) {
      sendJson(res, 400, { error: "Faltan datos validos para registrar el pago." });
      return;
    }

    const result = await pool.query(
      `
        insert into public.payments (
          user_id,
          package_name,
          class_count,
          amount,
          payment_method,
          payment_status
        )
        values ($1, $2, $3, $4, 'simulado', 'approved')
        returning id, user_id, package_name, class_count, amount, payment_method, payment_status, created_at
      `,
      [user.id, packageName, classCount, amount]
    );

    sendJson(res, 201, {
      payment: mapPaymentRow({
        ...result.rows[0],
        user_name: user.name,
        user_email: user.email
      })
    });
  } catch (error) {
    const schemaMessage = getSchemaHelpMessage(error, "registrar el pago");
    sendJson(res, 500, { error: schemaMessage || error.message || "No se pudo registrar el pago simulado." });
  }
}

// ============================================================
// MIDDLEWARE Y ENDPOINTS PARA AGENTES (API KEY)
// ============================================================

function requireAgentApiKey(req, res) {
  const agentApiKey = process.env.AGENT_API_KEY || "";
  if (!agentApiKey) {
    sendJson(res, 500, { error: "AGENT_API_KEY no configurada en el servidor." });
    return false;
  }
  const provided = req.headers["x-api-key"] || "";
  if (provided !== agentApiKey) {
    sendJson(res, 401, { error: "API key inválida o ausente." });
    return false;
  }
  return true;
}

function parseQuery(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return Object.fromEntries(url.searchParams);
}

// GET /api/agent/socio?email=X  → datos del socio
async function agentGetSocio(req, res, pathname) {
  if (!requireAgentApiKey(req, res)) return;
  const { email } = parseQuery(req);
  if (!email) return sendJson(res, 400, { error: "Falta el parámetro email." });

  try {
    const result = await pool.query(
      "SELECT id, name, email, role FROM public.users WHERE email = lower($1) LIMIT 1",
      [email]
    );
    if (!result.rows.length) return sendJson(res, 404, { error: "Socio no encontrado." });
    sendJson(res, 200, { socio: result.rows[0] });
  } catch (error) {
    sendJson(res, 500, { error: "No se pudo consultar el socio." });
  }
}

// POST /api/agent/reset-acceso  → resetear contraseña del socio
// Body: { email }
async function agentResetAcceso(req, res) {
  if (!requireAgentApiKey(req, res)) return;
  const body = await readBody(req);
  const { email } = body;
  if (!email) return sendJson(res, 400, { error: "Falta el campo email." });

  try {
    const tempPassword = crypto.randomBytes(4).toString("hex"); // ej: "a3f2b1c9"
    const passwordHash = await createPasswordHash(tempPassword);
    const result = await pool.query(
      "UPDATE public.users SET password_hash = $1 WHERE email = lower($2) RETURNING id, name, email",
      [passwordHash, email]
    );
    if (!result.rowCount) return sendJson(res, 404, { error: "Socio no encontrado." });
    sendJson(res, 200, {
      ok: true,
      socio: result.rows[0],
      tempPassword,
      mensaje: `Acceso reseteado. Contraseña temporal: ${tempPassword}. El socio debe cambiarla al ingresar.`
    });
  } catch (error) {
    sendJson(res, 500, { error: "No se pudo resetear el acceso." });
  }
}

// GET /api/agent/turnos?email=X  → reservas del socio
async function agentGetTurnos(req, res, pathname) {
  if (!requireAgentApiKey(req, res)) return;
  const { email } = parseQuery(req);
  if (!email) return sendJson(res, 400, { error: "Falta el parámetro email." });

  try {
    const userResult = await pool.query(
      "SELECT id FROM public.users WHERE email = lower($1) LIMIT 1",
      [email]
    );
    if (!userResult.rows.length) return sendJson(res, 404, { error: "Socio no encontrado." });
    const userId = userResult.rows[0].id;

    const result = await pool.query(
      `SELECT b.id, b.teacher_id, b.teacher_name, b.specialty,
              b.booking_date, b.booking_time,
              counts.slot_count
       FROM public.bookings b
       JOIN (
         SELECT teacher_id, booking_date, booking_time, count(*)::int AS slot_count
         FROM public.bookings GROUP BY teacher_id, booking_date, booking_time
       ) counts
         ON counts.teacher_id = b.teacher_id
        AND counts.booking_date = b.booking_date
        AND counts.booking_time = b.booking_time
       WHERE b.user_id = $1
       ORDER BY b.booking_date, b.booking_time`,
      [userId]
    );

    const credits = await getUserCredits(userId);
    sendJson(res, 200, { turnos: result.rows.map(mapBookingRow), credits });
  } catch (error) {
    sendJson(res, 500, { error: "No se pudo consultar los turnos." });
  }
}

// GET /api/agent/pagos?email=X  → pagos del socio
async function agentGetPagos(req, res, pathname) {
  if (!requireAgentApiKey(req, res)) return;
  const { email } = parseQuery(req);
  if (!email) return sendJson(res, 400, { error: "Falta el parámetro email." });

  try {
    const userResult = await pool.query(
      "SELECT id FROM public.users WHERE email = lower($1) LIMIT 1",
      [email]
    );
    if (!userResult.rows.length) return sendJson(res, 404, { error: "Socio no encontrado." });
    const userId = userResult.rows[0].id;

    const result = await pool.query(
      `SELECT p.id, p.package_name, p.class_count, p.amount,
              p.payment_method, p.payment_status, p.created_at,
              u.name AS user_name, u.email AS user_email
       FROM public.payments p
       JOIN public.users u ON u.id = p.user_id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC`,
      [userId]
    );

    const credits = await getUserCredits(userId);
    sendJson(res, 200, { pagos: result.rows.map(mapPaymentRow), credits });
  } catch (error) {
    sendJson(res, 500, { error: "No se pudo consultar los pagos." });
  }
}

// GET /api/agent/disponibilidad?teacherId=X&date=Y&time=Z  → cupo disponible en un turno
async function agentGetDisponibilidad(req, res, pathname) {
  if (!requireAgentApiKey(req, res)) return;
  const { teacherId, date, time } = parseQuery(req);
  if (!teacherId || !date || !time)
    return sendJson(res, 400, { error: "Faltan parámetros: teacherId, date, time." });

  try {
    const result = await pool.query(
      "SELECT count(*)::int AS ocupados FROM public.bookings WHERE teacher_id = $1 AND booking_date = $2 AND booking_time = $3",
      [teacherId, date, time]
    );
    const ocupados = result.rows[0].ocupados;
    const capacidad = 5;
    sendJson(res, 200, {
      teacherId, date, time,
      ocupados,
      capacidad,
      disponibles: capacidad - ocupados,
      disponible: ocupados < capacidad
    });
  } catch (error) {
    sendJson(res, 500, { error: "No se pudo consultar la disponibilidad." });
  }
}

// PUT /api/agent/turnos/:id/instructor  → reasignar instructor a un turno
// Body: { teacherId, teacherName, specialty }
async function agentReasignarInstructor(req, res, id) {
  if (!requireAgentApiKey(req, res)) return;
  const body = await readBody(req);
  const { teacherId, teacherName, specialty } = body;
  if (!teacherId || !teacherName || !specialty)
    return sendJson(res, 400, { error: "Faltan campos: teacherId, teacherName, specialty." });

  try {
    const result = await pool.query(
      `UPDATE public.bookings
       SET teacher_id = $1, teacher_name = $2, specialty = $3
       WHERE id = $4
       RETURNING id, user_id, teacher_id, teacher_name, specialty, booking_date, booking_time`,
      [teacherId, teacherName, specialty, id]
    );
    if (!result.rowCount) return sendJson(res, 404, { error: "Turno no encontrado." });
    sendJson(res, 200, { ok: true, turno: mapBookingRow({ ...result.rows[0], slot_count: 0 }) });
  } catch (error) {
    sendJson(res, 500, { error: "No se pudo reasignar el instructor." });
  }
}

async function handleApiRequest(req, res, pathname) {
  if (req.method === "POST" && pathname === "/api/register") {
    await handleRegister(req, res);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    await handleLogin(req, res);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    await handleLogout(req, res);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/me") {
    await handleMe(req, res);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/bookings") {
    await listBookings(req, res);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/bookings") {
    await createBooking(req, res);
    return true;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/bookings/")) {
    const id = pathname.replace("/api/bookings/", "");
    await deleteBooking(req, res, id);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/payments") {
    await listPayments(req, res);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/payments") {
    await createPayment(req, res);
    return true;
  }

  // ── Endpoints para agentes (requieren x-api-key) ──────────────────────────

  if (req.method === "GET" && pathname.startsWith("/api/agent/socio")) {
    await agentGetSocio(req, res, pathname);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/agent/reset-acceso") {
    await agentResetAcceso(req, res);
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/api/agent/turnos")) {
    await agentGetTurnos(req, res, pathname);
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/api/agent/pagos")) {
    await agentGetPagos(req, res, pathname);
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/api/agent/disponibilidad")) {
    await agentGetDisponibilidad(req, res, pathname);
    return true;
  }

  if (req.method === "PUT" && pathname.startsWith("/api/agent/turnos/") && pathname.endsWith("/instructor")) {
    const id = pathname.split("/")[4];
    await agentReasignarInstructor(req, res, id);
    return true;
  }

  return false;
}

module.exports = {
  handleApiRequest
};
