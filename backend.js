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
    details.includes("violates not-null constraint") ||
    details.includes("constraint") ||
    error?.code === "42703"
  ) {
    return `No se pudo ${action} porque tu tabla bookings parece estar con el esquema viejo. Vuelve a ejecutar neon-schema.sql o recrea las tablas.`;
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
      }))
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

  return false;
}

module.exports = {
  handleApiRequest
};
