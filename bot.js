/******************************************************************
 * 🔥 CARGA DE VARIABLES DE ENTORNO
 ******************************************************************/
import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";
import pkg from "pg";
import { stringify } from "csv-stringify/sync";

const { Pool } = pkg;

/******************************************************************
 * ⚙️ VARIABLES DE ENTORNO
 ******************************************************************/
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DF_PROJECT_ID = process.env.DF_PROJECT_ID;
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL;

if (!TELEGRAM_TOKEN) throw new Error("❌ FALTA TELEGRAM_TOKEN");
if (!DEEPSEEK_API_KEY) throw new Error("❌ FALTA DEEPSEEK_API_KEY");
if (!DF_PROJECT_ID) throw new Error("❌ FALTA DF_PROJECT_ID");
if (!DATABASE_URL) throw new Error("❌ FALTA DATABASE_URL");

/******************************************************************
 * 🗄️ CONEXIÓN POSTGRESQL
 ******************************************************************/
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/******************************************************************
 * ✅ CREAR TABLAS
 ******************************************************************/
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      servicio TEXT,
      fecha TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS interacciones (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      mensaje TEXT,
      respuesta TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/******************************************************************
 * 🌐 EXPRESS
 ******************************************************************/
const app = express();
app.use(express.json());

/******************************************************************
 * 🤖 BOT
 ******************************************************************/
const bot = new Telegraf(TELEGRAM_TOKEN);
const userState = {};
const dfClient = new dialogflow.SessionsClient();

/******************************************************************
 * 🧠 GUARDAR INTERACCIONES
 ******************************************************************/
async function guardarInteraccion(userId, mensaje, respuesta) {
  await db.query(
    "INSERT INTO interacciones (user_id, mensaje, respuesta) VALUES ($1,$2,$3)",
    [userId, mensaje, respuesta]
  );
}

/******************************************************************
 * 🧠 NUEVO: OBTENER ÚLTIMA SOLICITUD DEL USUARIO
 ******************************************************************/
async function getUltimaSolicitud(userId) {
  const result = await db.query(
    "SELECT servicio, fecha FROM solicitudes WHERE user_id=$1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return result.rows[0] || null;
}

/******************************************************************
 * 🧠 DETECTAR INTENCIÓN
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
 * 🤖 IA FALLBACK
 ******************************************************************/
async function askDeepSeek(text) {
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
}

/******************************************************************
 * START
 ******************************************************************/
bot.start((ctx) => {
  ctx.reply(`¡Hola ${ctx.from.first_name}! 👋`);
});

/******************************************************************
 * MENSAJES
 ******************************************************************/
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  /********************* FLUJOS EN CURSO *********************/
  if (userState[userId]) {
    const estado = userState[userId];

    if (estado.paso === "servicio") {
      estado.datos.servicio = text;
      estado.paso = "fecha";
      return ctx.reply("📅 ¿Para qué fecha necesitas el servicio?");
    }

    if (estado.paso === "fecha") {
      estado.datos.fecha = text;

      await db.query(
        "INSERT INTO solicitudes (user_id, servicio, fecha) VALUES ($1,$2,$3)",
        [userId, estado.datos.servicio, estado.datos.fecha]
      );

      const msg = `✅ Solicitud registrada:\n🛠️ ${estado.datos.servicio}\n📅 ${estado.datos.fecha}`;
      await guardarInteraccion(userId, text, msg);

      delete userState[userId];
      return ctx.reply(msg);
    }

    if (estado.paso === "modificar_id") {
      estado.id = text;
      estado.paso = "modificar_servicio";
      return ctx.reply("🛠️ Nuevo servicio:");
    }

    if (estado.paso === "modificar_servicio") {
      estado.servicio = text;
      estado.paso = "modificar_fecha";
      return ctx.reply("📅 Nueva fecha:");
    }

    if (estado.paso === "modificar_fecha") {
      await db.query(
        "UPDATE solicitudes SET servicio=$1, fecha=$2 WHERE id=$3",
        [estado.servicio, text, estado.id]
      );
      delete userState[userId];
      return ctx.reply("✅ Solicitud modificada correctamente.");
    }

    if (estado.paso === "cancelar_id") {
      await db.query("DELETE FROM solicitudes WHERE id=$1", [text]);
      delete userState[userId];
      return ctx.reply("🗑️ Solicitud cancelada.");
    }
  }

  /********************* REPORTE *********************/
  if (text.toLowerCase() === "reporte") {
    const result = await db.query("SELECT * FROM solicitudes ORDER BY id DESC");
    const csv = stringify(result.rows, { header: true });

    return ctx.replyWithDocument({
      source: Buffer.from(csv),
      filename: "reporte.csv",
    });
  }

  /********************* INTENCIONES *********************/
  const intent = await detectIntent(text, userId);

  if (intent === "Solicitud") {
    const ultima = await getUltimaSolicitud(userId);

    userState[userId] = { paso: "servicio", datos: {} };

    if (ultima) {
      return ctx.reply(
        `🧠 La última vez solicitaste:\n🛠️ ${ultima.servicio}\n📅 ${ultima.fecha}\n\n¿Deseas el mismo servicio o uno diferente?`
      );
    }

    return ctx.reply("¿Qué servicio necesitas?");
  }

  if (intent === "ModificarSolicitud") {
    userState[userId] = { paso: "modificar_id" };
    return ctx.reply("🔎 Indica el ID de la solicitud a modificar:");
  }

  if (intent === "CancelarSolicitud") {
    userState[userId] = { paso: "cancelar_id" };
    return ctx.reply("🔎 Indica el ID de la solicitud a cancelar:");
  }

  if (intent === "ConsultarSolicitudes") {
    const result = await db.query(
      "SELECT id, servicio, fecha FROM solicitudes ORDER BY id DESC LIMIT 5"
    );

    let msg = "📋 Últimas solicitudes:\n\n";
    result.rows.forEach((r) => {
      msg += `🆔 ${r.id} | ${r.servicio} | ${r.fecha}\n`;
    });

    return ctx.reply(msg);
  }

  /********************* IA *********************/
  const aiReply = await askDeepSeek(text);
  await guardarInteraccion(userId, text, aiReply);
  return ctx.reply(aiReply);
});

/******************************************************************
 * WEBHOOK + START
 ******************************************************************/
const WEBHOOK_PATH = "/telegram";
app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

async function start() {
  await initDB();
  app.listen(PORT);
}
start();
