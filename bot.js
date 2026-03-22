import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";
import pkg from "pg";
import { stringify } from "csv-stringify/sync";

const { Pool } = pkg;

/******************************************************************
 VARIABLES
******************************************************************/

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DF_PROJECT_ID = process.env.DF_PROJECT_ID;
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL;

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json());

const bot = new Telegraf(TELEGRAM_TOKEN);
const dfClient = new dialogflow.SessionsClient();

/******************************************************************
 TABLAS
******************************************************************/

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id SERIAL PRIMARY KEY,
      nombre TEXT,
      codigo TEXT,
      telegram_id BIGINT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      empresa_id INTEGER,
      servicio TEXT,
      fecha TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS estados_conversacion (
      user_id BIGINT PRIMARY KEY,
      paso TEXT,
      datos JSONB,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/******************************************************************
 ESTADO
******************************************************************/

const getEstado = async (userId) => {
  const r = await db.query(
    "SELECT paso, datos FROM estados_conversacion WHERE user_id=$1",
    [userId]
  );
  return r.rows[0] || null;
};

const setEstado = async (userId, paso, datos = {}) => {
  await db.query(
    `INSERT INTO estados_conversacion (user_id, paso, datos)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id)
     DO UPDATE SET paso=$2, datos=$3, updated_at=CURRENT_TIMESTAMP`,
    [userId, paso, datos]
  );
};

const clearEstado = async (userId) => {
  await db.query("DELETE FROM estados_conversacion WHERE user_id=$1", [userId]);
};

/******************************************************************
 IA + INTENTS
******************************************************************/

async function detectIntent(text, sessionId) {
  try {
    if (!DF_PROJECT_ID) return "fallback";

    const sessionPath = dfClient.projectAgentSessionPath(
      DF_PROJECT_ID,
      sessionId.toString()
    );

    const [response] = await dfClient.detectIntent({
      session: sessionPath,
      queryInput: {
        text: {
          text,
          languageCode: "es",
        },
      },
    });

    return response.queryResult.intent?.displayName || "fallback";
  } catch (error) {
    console.error("Error Dialogflow:", error.message);
    return "fallback";
  }
}

async function askDeepSeek(text) {
  try {
    if (!DEEPSEEK_API_KEY) {
      return "No pude responder en este momento.";
    }

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek/deepseek-chat",
          messages: [{ role: "user", content: text }],
        }),
      }
    );

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "No pude responder.";
  } catch (error) {
    console.error("Error DeepSeek:", error.message);
    return "No pude responder en este momento.";
  }
}

/******************************************************************
 HELPERS
******************************************************************/

async function esEmpresa(userId) {
  const r = await db.query(
    "SELECT id, nombre, codigo, telegram_id FROM empresas WHERE telegram_id=$1",
    [userId]
  );
  return r.rows[0] || null;
}

async function obtenerEmpresaPorId(empresaId) {
  const r = await db.query(
    "SELECT id, nombre, codigo, telegram_id FROM empresas WHERE id=$1",
    [empresaId]
  );
  return r.rows[0] || null;
}

async function obtenerEmpresaSeleccionada(userId) {
  const estado = await getEstado(userId);
  return estado?.datos?.empresa_id || null;
}

async function mostrarMenu(ctx) {
  const userId = ctx.from.id;
  const empresa = await esEmpresa(userId);

  if (empresa) {
    return ctx.reply("🏢 Panel empresa", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📥 Ver solicitudes", callback_data: "empresa_ver_solicitudes" }],
          [{ text: "📊 Reportes", callback_data: "empresa_reportes" }],
        ],
      },
    });
  }

  return ctx.reply("📍 Menú principal", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Nueva solicitud", callback_data: "nueva_solicitud" }],
        [{ text: "📋 Ver solicitudes", callback_data: "ver_solicitudes" }],
        [{ text: "🏢 Elegir empresa", callback_data: "elegir_empresa" }],
      ],
    },
  });
}

async function mostrarEmpresas(ctx) {
  const r = await db.query("SELECT id, nombre FROM empresas ORDER BY id ASC");

  if (r.rows.length === 0) {
    return ctx.reply("No hay empresas registradas");
  }

  const botones = r.rows.map((e) => [
    { text: e.nombre, callback_data: `seleccionar_empresa_${e.id}` },
  ]);

  return ctx.reply("Selecciona empresa", {
    reply_markup: {
      inline_keyboard: botones,
    },
  });
}
async function mostrarSolicitudesCliente(ctx, userId, empresaId) {
  if (!empresaId) {
    return ctx.reply("⚠️ Selecciona una empresa primero", {
      reply_markup: {
        inline_keyboard: [[
          { text: "🏢 Elegir empresa", callback_data: "elegir_empresa" },
        ]],
      },
    });
  }

  const r = await db.query(
    `SELECT id, servicio, fecha
     FROM solicitudes
     WHERE user_id=$1 AND empresa_id=$2
     ORDER BY id DESC
     LIMIT 10`,
    [userId, empresaId]
  );

  if (r.rows.length === 0) {
    return ctx.reply("📭 No tienes solicitudes aún");
  }

  let texto = "📋 *Tus solicitudes:*\n\n";
  const botones = [];

  r.rows.forEach((s, i) => {
    texto += `*${i + 1}.* 🛠 *${s.servicio}*\n📅 ${s.fecha}\n🆔 ${s.id}\n\n`;

    botones.push([
      {
        text: `✏️ Modificar #${s.id}`,
        callback_data: `modificar_${s.id}`
      }
    ]);
    botones.push([
      {
        text: `❌ Cancelar #${s.id} · ${s.servicio} · ${s.fecha}`,
        callback_data: `cancelar_${s.id}`
      }
    ]);
  });

  return ctx.reply(texto, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: botones,
    },
  });
}

async function mostrarSolicitudesEmpresa(ctx, empresaId) {
  const r = await db.query(
    `SELECT id, servicio, fecha, user_id
     FROM solicitudes
     WHERE empresa_id=$1
     ORDER BY id DESC
     LIMIT 10`,
    [empresaId]
  );

  if (r.rows.length === 0) {
    return ctx.reply("📭 No tienes solicitudes");
  }

  let texto = "📥 *Solicitudes recibidas:*\n\n";
  const botones = [];

  r.rows.forEach((s, i) => {
    texto += `${i + 1}. 🛠 ${s.servicio}\n📅 ${s.fecha}\n👤 Cliente: ${s.user_id}\n\n`;
    botones.push([
      { text: `✅ Aceptar ${s.id}`, callback_data: `aceptar_${s.id}` },
      { text: `❌ Rechazar ${s.id}`, callback_data: `rechazar_${s.id}` },
    ]);
  });

  return ctx.reply(texto, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: botones,
    },
  });
}

async function enviarReporteEmpresa(ctx, empresaId) {
  const r = await db.query(
    `SELECT id, servicio, fecha, user_id, created_at
     FROM solicitudes
     WHERE empresa_id=$1
     ORDER BY id DESC`,
    [empresaId]
  );

  if (r.rows.length === 0) {
    return ctx.reply("No hay solicitudes para generar reporte.");
  }

  const csv = stringify(r.rows, {
    header: true,
    columns: ["id", "servicio", "fecha", "user_id", "created_at"],
  });

  return ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: "reporte_solicitudes.csv",
  });
}

/******************************************************************
 SELECCIÓN DE EMPRESA
******************************************************************/

bot.action(/^seleccionar_empresa_(\d+)$/, async (ctx) => {
  const empresaId = Number(ctx.match[1]);
  const userId = ctx.from.id;

  const empresa = await obtenerEmpresaPorId(empresaId);
  if (!empresa) {
    await ctx.answerCbQuery("Empresa no encontrada");
    return;
  }

  const estadoActual = await getEstado(userId);

  await setEstado(userId, "menu", {
    ...(estadoActual?.datos || {}),
    empresa_id: empresaId,
    iniciado: true,
  });

  await ctx.answerCbQuery();
  await ctx.reply(`🏢 Empresa seleccionada: ${empresa.nombre}`);
  return mostrarMenu(ctx);
});

/******************************************************************
 RESPUESTA EMPRESA
******************************************************************/

bot.action(/^aceptar_(\d+)$/, async (ctx) => {
  const solicitudId = Number(ctx.match[1]);
  const userId = ctx.from.id;

  const empresa = await esEmpresa(userId);
  if (!empresa) {
    return ctx.answerCbQuery("Solo una empresa puede aceptar");
  }

  const r = await db.query(
    `SELECT id, user_id, servicio, fecha, empresa_id
     FROM solicitudes
     WHERE id=$1`,
    [solicitudId]
  );

  if (!r.rows.length) {
    return ctx.answerCbQuery("Solicitud no encontrada");
  }

  const solicitud = r.rows[0];

  if (Number(solicitud.empresa_id) !== Number(empresa.id)) {
    return ctx.answerCbQuery("Esta solicitud no pertenece a tu empresa");
  }

  await bot.telegram.sendMessage(
    solicitud.user_id,
    `✅ Tu solicitud fue aceptada

Servicio: ${solicitud.servicio}
Fecha: ${solicitud.fecha}`
  );

  await ctx.answerCbQuery("Aceptada");
  return ctx.editMessageText(`✅ Solicitud #${solicitudId} aceptada`);
});

bot.action(/^rechazar_(\d+)$/, async (ctx) => {
  const solicitudId = Number(ctx.match[1]);
  const userId = ctx.from.id;

  const empresa = await esEmpresa(userId);
  if (!empresa) {
    return ctx.answerCbQuery("Solo una empresa puede rechazar");
  }

  const r = await db.query(
    `SELECT id, user_id, servicio, fecha, empresa_id
     FROM solicitudes
     WHERE id=$1`,
    [solicitudId]
  );

  if (!r.rows.length) {
    return ctx.answerCbQuery("Solicitud no encontrada");
  }

  const solicitud = r.rows[0];

  if (Number(solicitud.empresa_id) !== Number(empresa.id)) {
    return ctx.answerCbQuery("Esta solicitud no pertenece a tu empresa");
  }

  await bot.telegram.sendMessage(
    solicitud.user_id,
    `❌ Tu solicitud fue rechazada

Servicio: ${solicitud.servicio}
Fecha: ${solicitud.fecha}`
  );

  await ctx.answerCbQuery("Rechazada");
  return ctx.editMessageText(`❌ Solicitud #${solicitudId} rechazada`);
});
/******************************************************************
 CLIENTE: MODIFICAR / CANCELAR
******************************************************************/

bot.action(/^modificar_(\d+)$/, async (ctx) => {
  const solicitudId = Number(ctx.match[1]);
  const userId = ctx.from.id;

  const r = await db.query(
    "SELECT id, user_id, empresa_id FROM solicitudes WHERE id=$1",
    [solicitudId]
  );

  if (!r.rows.length) {
    return ctx.answerCbQuery("Solicitud no encontrada");
  }

  const solicitud = r.rows[0];

  if (Number(solicitud.user_id) !== Number(userId)) {
    return ctx.answerCbQuery("Esta solicitud no es tuya");
  }

  const estadoActual = await getEstado(userId);

  await setEstado(userId, "modificar_fecha", {
    ...(estadoActual?.datos || {}),
    solicitud_id: solicitudId,
    empresa_id: solicitud.empresa_id,
    iniciado: true,
  });

  await ctx.answerCbQuery();
  return ctx.reply("📅 Escribe la nueva fecha");
});

bot.action(/^cancelar_(\d+)$/, async (ctx) => {
  const solicitudId = Number(ctx.match[1]);
  const userId = ctx.from.id;

  const r = await db.query(
    "SELECT id, user_id, empresa_id, servicio, fecha FROM solicitudes WHERE id=$1",
    [solicitudId]
  );

  if (!r.rows.length) {
    return ctx.answerCbQuery("Solicitud no encontrada");
  }

  const solicitud = r.rows[0];

  if (Number(solicitud.user_id) !== Number(userId)) {
    return ctx.answerCbQuery("Esta solicitud no es tuya");
  }

  const empresa = await db.query(
    "SELECT telegram_id FROM empresas WHERE id=$1",
    [solicitud.empresa_id]
  );

  await db.query("DELETE FROM solicitudes WHERE id=$1", [solicitudId]);

  if (empresa.rows[0]?.telegram_id) {
    await bot.telegram.sendMessage(
      empresa.rows[0].telegram_id,
      `❌ El cliente canceló la solicitud #${solicitudId}

👤 Cliente: ${ctx.from.first_name}
🛠 Servicio: ${solicitud.servicio}
📅 Fecha: ${solicitud.fecha}`
    );
  }

  await ctx.answerCbQuery("Cancelada");
  return ctx.editMessageText(`❌ Solicitud ${solicitudId} cancelada`);
});

/******************************************************************
 START + INICIO
******************************************************************/

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const estadoActual = await getEstado(userId);

  await setEstado(userId, "inicio", {
    ...(estadoActual?.datos || {}),
    iniciado: false,
  });

  return ctx.reply(
    `👋 Hola ${ctx.from.first_name}

Bienvenido a tu asistente`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "🚀 Iniciar", callback_data: "iniciar_bot" },
        ]],
      },
    }
  );
});

bot.action("iniciar_bot", async (ctx) => {
  const userId = ctx.from.id;
  const estadoActual = await getEstado(userId);

  await setEstado(userId, "menu", {
    ...(estadoActual?.datos || {}),
    iniciado: true,
  });

  await ctx.answerCbQuery();
  return mostrarMenu(ctx);
});

/******************************************************************
 MENÚ ACCIONES
******************************************************************/

bot.action("elegir_empresa", async (ctx) => {
  await ctx.answerCbQuery();
  return mostrarEmpresas(ctx);
});

bot.action("ver_solicitudes", async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const empresaId = await obtenerEmpresaSeleccionada(userId);

  return mostrarSolicitudesCliente(ctx, userId, empresaId);
});

bot.action("nueva_solicitud", async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const estado = await getEstado(userId);
  const empresaId = estado?.datos?.empresa_id;

  if (!empresaId) {
    return ctx.reply("⚠️ Primero selecciona una empresa", {
      reply_markup: {
        inline_keyboard: [[
          { text: "🏢 Elegir empresa", callback_data: "elegir_empresa" },
        ]],
      },
    });
  }

  await setEstado(userId, "servicio", {
    ...(estado?.datos || {}),
    empresa_id: empresaId,
    iniciado: true,
  });

  return ctx.reply("¿Qué servicio necesitas?");
});

bot.action("empresa_ver_solicitudes", async (ctx) => {
  await ctx.answerCbQuery();

  const empresa = await esEmpresa(ctx.from.id);
  if (!empresa) {
    return ctx.reply("No eres empresa");
  }

  return mostrarSolicitudesEmpresa(ctx, empresa.id);
});

bot.action("empresa_reportes", async (ctx) => {
  await ctx.answerCbQuery();

  const empresa = await esEmpresa(ctx.from.id);
  if (!empresa) {
    return ctx.reply("No eres empresa");
  }

  return enviarReporteEmpresa(ctx, empresa.id);
});
/******************************************************************
 MENSAJES
******************************************************************/

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;

  console.log("👤", userId, "💬", text);

  /**************** COMANDOS QUE DEBEN FUNCIONAR SIEMPRE ****************/

  if (text.startsWith("/crear_empresa")) {
    const partes = text.split(" ");
    const nombre = partes[1];
    const codigo = partes[2];

    if (!nombre || !codigo) {
      return ctx.reply("Uso correcto: /crear_empresa nombre codigo");
    }

    await db.query(
      "INSERT INTO empresas (nombre,codigo) VALUES ($1,$2)",
      [nombre, codigo]
    );

    return ctx.reply("Empresa creada");
  }

  if (text.startsWith("/soy_empresa")) {
    const codigo = text.split(" ")[1];

    if (!codigo) {
      return ctx.reply("Uso correcto: /soy_empresa codigo");
    }

    const r = await db.query(
      "SELECT id FROM empresas WHERE codigo=$1",
      [codigo]
    );

    if (r.rows.length === 0) {
      return ctx.reply("Código inválido");
    }

    await db.query(
      "UPDATE empresas SET telegram_id=$1 WHERE id=$2",
      [userId, r.rows[0].id]
    );

    const estadoActual = await getEstado(userId);

    await setEstado(userId, "menu", {
      ...(estadoActual?.datos || {}),
      iniciado: true,
    });

    await ctx.reply("Empresa vinculada");
    return mostrarMenu(ctx);
  }

  /******** BLOQUEO GLOBAL ********/

  const estadoGlobal = await getEstado(userId);

  if (!estadoGlobal || !estadoGlobal.datos?.iniciado) {
    return ctx.reply("⚠️ Debes iniciar primero", {
      reply_markup: {
        inline_keyboard: [[
          { text: "🚀 Iniciar", callback_data: "iniciar_bot" },
        ]],
      },
    });
  }

  /**************** REPORTE ****************/

  if (text.toLowerCase() === "reporte") {
    const empresa = await esEmpresa(userId);

    if (!empresa) {
      return ctx.reply("Solo empresas pueden usar reportes");
    }

    return enviarReporteEmpresa(ctx, empresa.id);
  }

  /**************** ESTADO / CONTEXTO ****************/

  const estado = await getEstado(userId);
  const datos = estado?.datos || {};
  const empresaId = datos.empresa_id;
  const empresaLogueada = await esEmpresa(userId);

  if (!empresaId && !empresaLogueada) {
    return ctx.reply("⚠️ Selecciona una empresa", {
      reply_markup: {
        inline_keyboard: [[
          { text: "🏢 Elegir empresa", callback_data: "elegir_empresa" },
        ]],
      },
    });
  }

  /**************** ESTADOS DEL FLUJO ****************/

  if (estado?.paso === "servicio") {
    await setEstado(userId, "fecha", {
      ...datos,
      servicio: text,
      iniciado: true,
    });

    return ctx.reply("¿Para qué fecha?");
  }

  if (estado?.paso === "fecha") {
    const empresaIdEstado = datos.empresa_id;
    const servicio = datos.servicio;

    if (!empresaIdEstado || !servicio) {
      await setEstado(userId, "menu", {
        ...datos,
        iniciado: true,
      });
      return ctx.reply("⚠️ Faltan datos para registrar la solicitud. Intenta de nuevo.");
    }

    const result = await db.query(
      `INSERT INTO solicitudes (user_id, empresa_id, servicio, fecha)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, empresaIdEstado, servicio, text]
    );

    const solicitudId = result.rows[0].id;

    const empresa = await db.query(
      "SELECT telegram_id FROM empresas WHERE id=$1",
      [empresaIdEstado]
    );

    if (empresa.rows[0]?.telegram_id) {
      await bot.telegram.sendMessage(
        empresa.rows[0].telegram_id,
        `📩 Nueva solicitud #${solicitudId}

👤 Cliente: ${ctx.from.first_name}
🛠 Servicio: ${servicio}
📅 Fecha: ${text}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Aceptar", callback_data: `aceptar_${solicitudId}` },
              { text: "❌ Rechazar", callback_data: `rechazar_${solicitudId}` },
            ]],
          },
        }
      );
    }

    await setEstado(userId, "menu", {
      ...datos,
      iniciado: true,
      empresa_id: empresaIdEstado,
    });

    return ctx.reply("✅ Solicitud registrada");
  }

  if (estado?.paso === "modificar_fecha") {
    const solicitudId = datos.solicitud_id;

    if (!solicitudId) {
      await setEstado(userId, "menu", {
        ...datos,
        iniciado: true,
      });
      return ctx.reply("⚠️ No encontré la solicitud a modificar.");
    }

    const r = await db.query(
      "SELECT id, user_id, empresa_id, servicio, fecha FROM solicitudes WHERE id=$1",
      [solicitudId]
    );

    if (!r.rows.length) {
      await setEstado(userId, "menu", {
        ...datos,
        iniciado: true,
      });
      return ctx.reply("Solicitud no encontrada");
    }

    const solicitud = r.rows[0];

    if (Number(solicitud.user_id) !== Number(userId)) {
      return ctx.reply("No puedes modificar una solicitud que no es tuya");
    }

    const fechaAnterior = solicitud.fecha;
    const nuevaFecha = text;

    await db.query(
      "UPDATE solicitudes SET fecha=$1 WHERE id=$2",
      [nuevaFecha, solicitudId]
    );

    const empresa = await db.query(
      "SELECT telegram_id FROM empresas WHERE id=$1",
      [solicitud.empresa_id]
    );

    if (empresa.rows[0]?.telegram_id) {
      await bot.telegram.sendMessage(
        empresa.rows[0].telegram_id,
        `✏️ El cliente modificó una solicitud #${solicitudId}

👤 Cliente: ${ctx.from.first_name}
🛠 Servicio: ${solicitud.servicio}
📅 Fecha anterior: ${fechaAnterior}
📅 Nueva fecha: ${nuevaFecha}`
      );
    }

    await setEstado(userId, "menu", {
      ...datos,
      iniciado: true,
      empresa_id: solicitud.empresa_id,
    });

    return ctx.reply("✅ Solicitud actualizada");
  }

  /**************** INTENTS / TEXTO ****************/

  const lower = text.toLowerCase();
let intent = await detectIntent(text, userId);

if (["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches"].includes(lower)) {
  return ctx.reply(
    `👋 Hola ${ctx.from.first_name}, ¿qué deseas hacer?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Nueva solicitud", callback_data: "nueva_solicitud" }],
          [{ text: "📋 Ver solicitudes", callback_data: "ver_solicitudes" }],
          [{ text: "🏢 Elegir empresa", callback_data: "elegir_empresa" }],
        ],
      },
    }
  );
}

if (lower === "ver solicitudes") intent = "ConsultarSolicitudes";
if (lower === "mis solicitudes") intent = "ConsultarSolicitudes";
if (lower === "nueva solicitud") intent = "Solicitud";
if (lower === "solicitar servicio") intent = "Solicitud";
if (lower === "nuevo servicio") intent = "Solicitud";
if (lower === "modificar solicitud") intent = "ModificarSolicitud";
if (lower === "cancelar solicitud") intent = "CancelarSolicitud";
  console.log("🎯 Intent:", intent);

  /**************** CONSULTAR SOLICITUDES CLIENTE ****************/

  if (intent === "ConsultarSolicitudes") {
    return mostrarSolicitudesCliente(ctx, userId, empresaId);
  }

  /**************** MODIFICAR SOLICITUD ****************/

  if (intent === "ModificarSolicitud") {
    if (!empresaId) {
      return ctx.reply("⚠️ Selecciona una empresa primero");
    }

    const r = await db.query(
      `SELECT id, servicio, fecha
       FROM solicitudes
       WHERE user_id=$1 AND empresa_id=$2
       ORDER BY id DESC
       LIMIT 10`,
      [userId, empresaId]
    );

    if (r.rows.length === 0) {
      return ctx.reply("No tienes solicitudes para modificar");
    }

    const botones = r.rows.map((s) => [
      { text: `✏️ ${s.servicio} - ${s.fecha}`, callback_data: `modificar_${s.id}` },
    ]);

    return ctx.reply("Selecciona la solicitud que quieres modificar", {
      reply_markup: {
        inline_keyboard: botones,
      },
    });
  }

  /**************** CANCELAR SOLICITUD ****************/

  if (intent === "CancelarSolicitud") {
    if (!empresaId) {
      return ctx.reply("⚠️ Selecciona una empresa primero");
    }

    const r = await db.query(
      `SELECT id, servicio, fecha
       FROM solicitudes
       WHERE user_id=$1 AND empresa_id=$2
       ORDER BY id DESC
       LIMIT 10`,
      [userId, empresaId]
    );

    if (r.rows.length === 0) {
      return ctx.reply("No tienes solicitudes para cancelar");
    }

    const botones = r.rows.map((s) => [
      { text: `❌ ${s.servicio} - ${s.fecha}`, callback_data: `cancelar_${s.id}` },
    ]);

    return ctx.reply("Selecciona la solicitud que quieres cancelar", {
      reply_markup: {
        inline_keyboard: botones,
      },
    });
  }

  /**************** NUEVA SOLICITUD ****************/

  if (intent === "Solicitud") {
    return ctx.reply("🏢 Primero selecciona la empresa para continuar", {
      reply_markup: {
        inline_keyboard: [[
          { text: "🏢 Elegir empresa", callback_data: "elegir_empresa" },
        ]],
      },
    });
  }

  /**************** RESPONDER EMPRESA → CLIENTE ****************/

  if (lower.startsWith("responder")) {
    const partes = text.split(" ");
    const solicitudId = partes[1];
    const mensaje = partes.slice(2).join(" ");

    if (!solicitudId || !mensaje) {
      return ctx.reply(`Uso correcto:

responder ID mensaje

Ejemplo:
responder 3 Tu servicio está confirmado`);
    }

    const empresa = await esEmpresa(userId);

    if (!empresa) {
      return ctx.reply("❌ Solo las empresas pueden responder solicitudes");
    }

    const r = await db.query(
      "SELECT user_id, empresa_id FROM solicitudes WHERE id=$1",
      [solicitudId]
    );

    if (r.rows.length === 0) {
      return ctx.reply("Solicitud no encontrada");
    }

    if (Number(r.rows[0].empresa_id) !== Number(empresa.id)) {
      return ctx.reply("❌ Esa solicitud no pertenece a tu empresa");
    }

    await bot.telegram.sendMessage(
      r.rows[0].user_id,
      `💬 Mensaje de la empresa (Solicitud #${solicitudId})

${mensaje}`
    );

    return ctx.reply("Mensaje enviado al cliente");
  }

  /**************** FALLBACK IA ****************/

  const ai = await askDeepSeek(text);
  return ctx.reply(ai);
});

/******************************************************************
 ERRORES
******************************************************************/

bot.catch((err, ctx) => {
  console.error("Unhandled bot error:", err);
  if (ctx?.update) {
    console.error("Update que falló:", JSON.stringify(ctx.update, null, 2));
  }
});

/******************************************************************
 WEBHOOK
******************************************************************/

const WEBHOOK_PATH = "/telegram";
app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

async function start() {
  try {
    await initDB();

    app.listen(PORT, () => {
      console.log("Servidor corriendo en puerto", PORT);
    });
  } catch (error) {
    console.error("ERROR AL INICIAR:", error);
  }
}

start();