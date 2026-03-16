import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";
import pkg from "pg";
import { stringify } from "csv-stringify/sync";

const { Pool } = pkg;

/******************************************************************
 * VARIABLES
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
 * TABLAS
 ******************************************************************/
async function initDB() {

  await db.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id SERIAL PRIMARY KEY,
      nombre TEXT
    );
  `);

  await db.query(`
    ALTER TABLE empresas
    ADD COLUMN IF NOT EXISTS codigo TEXT;
  `);

  await db.query(`
    ALTER TABLE empresas
    ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
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
 * ESTADO
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
     VALUES ($1,$2,$3)
     ON CONFLICT (user_id)
     DO UPDATE SET paso=$2, datos=$3, updated_at=CURRENT_TIMESTAMP`,
    [userId, paso, datos]
  );
};

const clearEstado = async (userId) => {
  await db.query("DELETE FROM estados_conversacion WHERE user_id=$1", [userId]);
};

/******************************************************************
 * MEMORIA
 ******************************************************************/
const getUltimaSolicitud = async (userId, empresaId) => {
  const r = await db.query(
    "SELECT servicio, fecha FROM solicitudes WHERE user_id=$1 AND empresa_id=$2 ORDER BY id DESC LIMIT 1",
    [userId, empresaId]
  );
  return r.rows[0] || null;
};

const getSolicitudesUsuario = async (userId, empresaId) => {
  const r = await db.query(
    "SELECT servicio, fecha FROM solicitudes WHERE user_id=$1 AND empresa_id=$2 ORDER BY id DESC LIMIT 5",
    [userId, empresaId]
  );
  return r.rows;
};

/******************************************************************
 * INTENT
 ******************************************************************/
async function detectIntent(text, sessionId) {

  try {

    const sessionPath = dfClient.projectAgentSessionPath(
      DF_PROJECT_ID,
      sessionId.toString()
    );

    const [response] = await dfClient.detectIntent({
      session: sessionPath,
      queryInput: { text: { text, languageCode: "es" } },
    });

    return response.queryResult.intent?.displayName || "fallback";

  } catch {

    return "fallback";

  }
}

/******************************************************************
 * IA
 ******************************************************************/
async function buildContextPrompt(userId, empresaId, userMessage) {

  const estado = await getEstado(userId);
  const solicitudes = await getSolicitudesUsuario(userId, empresaId);

  let historial = "";

  solicitudes.forEach((s, i) => {
    historial += `${i + 1}. Servicio: ${s.servicio}, Fecha: ${s.fecha}\n`;
  });

  return `
Eres el asistente virtual de un negocio que gestiona solicitudes.

Historial:
${historial || "Sin historial"}

Estado actual: ${estado?.paso || "Ninguno"}

Mensaje: "${userMessage}"
`;
}

async function askDeepSeek(userId, empresaId, text) {

  const prompt = await buildContextPrompt(userId, empresaId, text);

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
        messages: [{ role: "user", content: prompt }],
      }),
    }
  );

  const data = await response.json();

  return data.choices?.[0]?.message?.content || "No pude responder.";
}

/******************************************************************
 * EMPRESAS
 ******************************************************************/
async function mostrarEmpresas(ctx) {

  const r = await db.query("SELECT id,nombre FROM empresas");

  if (r.rows.length === 0) {
    return ctx.reply("No hay empresas registradas.");
  }

  const botones = r.rows.map(e => ({
    text: e.nombre,
    callback_data: "empresa_" + e.id
  }));

  return ctx.reply("Selecciona una empresa:", {
    reply_markup: {
      inline_keyboard: botones.map(b => [b])
    }
  });
}

bot.action(/empresa_(.+)/, async (ctx) => {

  const empresaId = ctx.match[1];
  const userId = ctx.from.id;

  const r = await db.query(
    "SELECT nombre FROM empresas WHERE id=$1",
    [empresaId]
  );

  const nombre = r.rows[0]?.nombre || "Empresa";

  await setEstado(userId, "empresa_seleccionada", { empresa_id: empresaId });

  await ctx.answerCbQuery();

  ctx.reply(`🏢 Empresa seleccionada: ${nombre}\n\nAhora puedes solicitar servicios.`);

});


/******************************************************************
 * RESPUESTA EMPRESA
 ******************************************************************/
bot.action(/aceptar_(.+)/, async (ctx) => {

  const solicitudId = ctx.match[1];

  const r = await db.query(
    "SELECT user_id, servicio, fecha FROM solicitudes WHERE id=$1",
    [solicitudId]
  );

  if (r.rows.length === 0) {
    return ctx.reply("Solicitud no encontrada.");
  }

  const solicitud = r.rows[0];
  const clienteId = solicitud.user_id;

  // notificar cliente
  await bot.telegram.sendMessage(
    clienteId,
    `✅ Tu solicitud fue ACEPTADA

Servicio: ${solicitud.servicio}
Fecha: ${solicitud.fecha}`
  );

  await ctx.answerCbQuery("Solicitud aceptada");

  await ctx.editMessageText(
    `✅ Solicitud aceptada

Servicio: ${solicitud.servicio}
Fecha: ${solicitud.fecha}`
  );

});

bot.action(/rechazar_(.+)/, async (ctx) => {

  const solicitudId = ctx.match[1];

  const r = await db.query(
    "SELECT user_id, servicio, fecha FROM solicitudes WHERE id=$1",
    [solicitudId]
  );

  if (r.rows.length === 0) {
    return ctx.reply("Solicitud no encontrada.");
  }

  const solicitud = r.rows[0];
  const clienteId = solicitud.user_id;

  // notificar cliente
  await bot.telegram.sendMessage(
    clienteId,
    `❌ Tu solicitud fue RECHAZADA

Servicio: ${solicitud.servicio}
Fecha: ${solicitud.fecha}`
  );

  await ctx.answerCbQuery("Solicitud rechazada");

  await ctx.editMessageText(
    `❌ Solicitud rechazada

Servicio: ${solicitud.servicio}
Fecha: ${solicitud.fecha}`
  );

});

/******************************************************************
 * START
 ******************************************************************/
bot.start(async (ctx) => {

  ctx.reply(`¡Hola ${ctx.from.first_name}! 👋`);

  await mostrarEmpresas(ctx);

});

/******************************************************************
 * MENSAJES
 ******************************************************************/
bot.on("text", async (ctx) => {

  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();
  const userId = ctx.from.id;

  console.log("👤", userId, "💬", text);

  /**************** COMANDOS ****************/

  if (text.startsWith("/crear_empresa")) {

    const partes = text.split(" ");
    const nombre = partes[1];
    const codigo = partes[2];

    await db.query(
      "INSERT INTO empresas (nombre,codigo) VALUES ($1,$2)",
      [nombre, codigo]
    );

    return ctx.reply(`✅ Empresa registrada

Nombre: ${nombre}
Código: ${codigo}`);

  }

  if (lower === "/ver_empresas") {

    const r = await db.query("SELECT id,nombre,codigo,telegram_id FROM empresas");
  
    let msg = "🏢 Empresas registradas\n\n";
  
    r.rows.forEach(e => {
      msg += `ID:${e.id}
  Nombre:${e.nombre}
  Código:${e.codigo}
  Telegram:${e.telegram_id}
  
  `;
    });
  
    return ctx.reply(msg);
  
  }

  if (lower === "reporte") {

    const estadoEmpresa = await getEstado(userId);
    const empresaId = estadoEmpresa?.datos?.empresa_id;
  
    if (!empresaId) {
      return ctx.reply("Primero selecciona una empresa.");
    }
  
    const r = await db.query(
      "SELECT id, servicio, fecha, user_id, created_at FROM solicitudes WHERE empresa_id=$1 ORDER BY id DESC",
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

  if (text.startsWith("/soy_empresa")) {

    const partes = text.split(" ");
    const codigo = partes[1];

    const r = await db.query(
      "SELECT id,nombre FROM empresas WHERE codigo=$1",
      [codigo]
    );

    if (r.rows.length === 0) {
      return ctx.reply("Código de empresa no válido.");
    }

    const empresa = r.rows[0];

    await db.query(
      "UPDATE empresas SET telegram_id=$1 WHERE id=$2",
      [userId, empresa.id]
    );

    return ctx.reply(`✅ Ahora eres la empresa: ${empresa.nombre}`);

  }

  if (lower === "/reset_empresa") {

    await clearEstado(userId);

    return mostrarEmpresas(ctx);

  }

  /**************** EMPRESA ****************/

  const estadoEmpresa = await getEstado(userId);
  const empresaId = estadoEmpresa?.datos?.empresa_id;

  if (!empresaId) {
    return mostrarEmpresas(ctx);
  }

  /**************** INTENT ****************/

  const intent = await detectIntent(text, userId);

  const intentsPrincipales = [
    "Solicitud",
    "ModificarSolicitud",
    "CancelarSolicitud",
    "ConsultarSolicitudes"
  ];
  
  if (intentsPrincipales.includes(intent)) {
  
    await clearEstado(userId);
    await setEstado(userId, "empresa_seleccionada", { empresa_id: empresaId });
  
    /**************** NUEVA SOLICITUD ****************/
  
    if (intent === "Solicitud") {
  
      const ultima = await getUltimaSolicitud(userId, empresaId);
  
      await setEstado(userId, "servicio", { empresa_id: empresaId });
  
      if (ultima) {
        return ctx.reply(
          `La última vez solicitaste:
  ${ultima.servicio} - ${ultima.fecha}
  
  ¿Qué servicio necesitas ahora?`
        );
      }
  
      return ctx.reply("¿Qué servicio necesitas?");
    }
  
    /**************** CONSULTAR ****************/
  
    if (intent === "ConsultarSolicitudes") {
  
      const r = await db.query(
        "SELECT id, servicio, fecha FROM solicitudes WHERE user_id=$1 AND empresa_id=$2 ORDER BY id DESC LIMIT 5",
        [userId, empresaId]
      );
  
      if (r.rows.length === 0) {
        return ctx.reply("No tienes solicitudes registradas.");
      }
  
      let msg = "📋 Tus últimas solicitudes:\n\n";
  
      r.rows.forEach(s => {
        msg += `ID ${s.id}
  Servicio: ${s.servicio}
  Fecha: ${s.fecha}
  
  `;
      });
  
      return ctx.reply(msg);
    }
  
    /**************** CANCELAR ****************/
  
    if (intent === "CancelarSolicitud") {
  
      const r = await db.query(
        "SELECT id, servicio FROM solicitudes WHERE user_id=$1 AND empresa_id=$2 ORDER BY id DESC LIMIT 1",
        [userId, empresaId]
      );
  
      if (r.rows.length === 0) {
        return ctx.reply("No tienes solicitudes para cancelar.");
      }
  
      const solicitud = r.rows[0];
  
      await db.query(
        "DELETE FROM solicitudes WHERE id=$1",
        [solicitud.id]
      );
  
      return ctx.reply(`❌ Solicitud cancelada:
  
  ${solicitud.servicio}`);
    }
  
    /**************** MODIFICAR ****************/
  
    if (intent === "ModificarSolicitud") {
  
      const r = await db.query(
        "SELECT id, servicio, fecha FROM solicitudes WHERE user_id=$1 AND empresa_id=$2 ORDER BY id DESC LIMIT 1",
        [userId, empresaId]
      );
  
      if (r.rows.length === 0) {
        return ctx.reply("No tienes solicitudes para modificar.");
      }
  
      const solicitud = r.rows[0];
  
      await setEstado(userId, "modificar_fecha", {
        solicitud_id: solicitud.id
      });
  
      return ctx.reply(
        `✏️ Modificando solicitud:
  
  Servicio: ${solicitud.servicio}
  Fecha actual: ${solicitud.fecha}
  
  Escribe la nueva fecha.`
      );
    }
  
  }
  /**************** ESTADOS ****************/

  const estado = await getEstado(userId);

  if (estado) {

    const datos = estado.datos || {};

    if (estado.paso === "servicio") {

      datos.servicio = text;

      await setEstado(userId, "fecha", datos);

      return ctx.reply("¿Para qué fecha necesitas el servicio?");
    }

    if (estado.paso === "fecha") {

      const result = await db.query(
        "INSERT INTO solicitudes (user_id,empresa_id,servicio,fecha) VALUES ($1,$2,$3,$4) RETURNING id",
        [userId, empresaId, datos.servicio, text]
      );

      const solicitudId = result.rows[0].id;

      const empresa = await db.query(
        "SELECT nombre,telegram_id FROM empresas WHERE id=$1",
        [empresaId]
      );

      const empresaData = empresa.rows[0];

      if (empresaData?.telegram_id) {

        await bot.telegram.sendMessage(
          empresaData.telegram_id,
          `📩 Nueva solicitud

Empresa: ${empresaData.nombre}
Servicio: ${datos.servicio}
Fecha: ${text}
Cliente ID: ${userId}
ID Solicitud: ${solicitudId}`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Aceptar", callback_data: `aceptar_${solicitudId}` },
                  { text: "❌ Rechazar", callback_data: `rechazar_${solicitudId}` }
                ]
              ]
            }
          }
        );

      }

      await clearEstado(userId);

      await setEstado(userId, "empresa_seleccionada", { empresa_id: empresaId });

      return ctx.reply("✅ Solicitud registrada correctamente");
    }

  }

  /**************** IA ****************/

  const ai = await askDeepSeek(userId, empresaId, text);

  return ctx.reply(ai);

});

/******************************************************************
 * WEBHOOK
 ******************************************************************/
const WEBHOOK_PATH = "/telegram";

app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

async function start() {

  await initDB();

  app.listen(PORT);

}

start();