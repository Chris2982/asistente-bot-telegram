import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";
import pkg from "pg";
import { stringify } from "csv-stringify/sync";

const { Pool } = pkg;

/******************************************************************
 * ⚙️ VARIABLES
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
 * 🗄️ TABLAS
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
    CREATE TABLE IF NOT EXISTS estados_conversacion (
      user_id BIGINT PRIMARY KEY,
      paso TEXT,
      datos JSONB,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/******************************************************************
 * 🧠 ESTADO CONVERSACIONAL
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
  await db.query("DELETE FROM estados_conversacion WHERE user_id=$1", [
    userId,
  ]);
};

/******************************************************************
 * 🧠 MEMORIA POR INTENCIÓN (ÚLTIMA SOLICITUD)
 ******************************************************************/
const getUltimaSolicitud = async (userId) => {
  const r = await db.query(
    "SELECT servicio, fecha FROM solicitudes WHERE user_id=$1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return r.rows[0] || null;
};

/******************************************************************
 * 🧠 INTENCIÓN
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
 * 🤖 IA
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
 * START (SALUDO CON NOMBRE)
 ******************************************************************/
bot.start((ctx) => {
  const nombre = ctx.from.first_name || "usuario";
  ctx.reply(`¡Hola ${nombre}! 👋`);
});

/******************************************************************
 * MENSAJES
 ******************************************************************/
bot.on("text", async (ctx) => {
  const rawText = ctx.message.text;
  const text = rawText.trim();
  const lower = text.toLowerCase();
  const userId = ctx.from.id;

  console.log("====================================");
  console.log("👤 Usuario:", userId);
  console.log("💬 Mensaje:", text);

  /**************** SALUDO RÁPIDO ****************/
  if (lower === "hola") {
    const nombre = ctx.from.first_name || "usuario";
    return ctx.reply(`¡Hola ${nombre}! ¿En qué puedo ayudarte?`);
  }

  // 1️⃣ Detectar intención
  const intent = await detectIntent(text, userId);
  console.log("🧠 Intent detectado:", intent);

  // 2️⃣ Limpiar estados si es intención principal
  const intentsPrincipales = [
    "Solicitud",
    "ModificarSolicitud",
    "CancelarSolicitud",
    "ConsultarSolicitudes",
  ];

  if (intentsPrincipales.includes(intent)) {
    await clearEstado(userId);
  }

  // 3️⃣ Revisar estado
  const estado = await getEstado(userId);

  if (estado) {
    const datos = estado.datos || {};

    if (estado.paso === "servicio") {
      datos.servicio = text;
      await setEstado(userId, "fecha", datos);
      return ctx.reply("📅 ¿Para qué fecha necesitas el servicio?");
    }

    if (estado.paso === "fecha") {
      datos.fecha = text;

      await db.query(
        "INSERT INTO solicitudes (user_id, servicio, fecha) VALUES ($1,$2,$3)",
        [userId, datos.servicio, datos.fecha]
      );

      console.log("✅ Solicitud guardada:", datos);

      await clearEstado(userId);
      return ctx.reply(
        `✅ Solicitud registrada:\n🛠️ ${datos.servicio}\n📅 ${datos.fecha}`
      );
    }

    if (estado.paso === "modificar_id") {
      if (isNaN(text)) {
        return ctx.reply("❌ Debes indicar un ID numérico.");
      }
      await setEstado(userId, "modificar_servicio", { id: text });
      return ctx.reply("🛠️ Nuevo servicio:");
    }

    if (estado.paso === "modificar_servicio") {
      datos.servicio = text;
      await setEstado(userId, "modificar_fecha", datos);
      return ctx.reply("📅 Nueva fecha:");
    }

    if (estado.paso === "modificar_fecha") {
      await db.query(
        "UPDATE solicitudes SET servicio=$1, fecha=$2 WHERE id=$3",
        [datos.servicio, text, datos.id]
      );
      await clearEstado(userId);
      return ctx.reply("✅ Solicitud modificada correctamente.");
    }

    if (estado.paso === "cancelar_id") {
      if (isNaN(text)) {
        return ctx.reply("❌ Debes indicar un ID numérico.");
      }
      await db.query("DELETE FROM solicitudes WHERE id=$1", [text]);
      await clearEstado(userId);
      return ctx.reply("🗑️ Solicitud cancelada.");
    }
  }

  /**************** REPORTE ****************/
  if (lower === "reporte") {
    const result = await db.query("SELECT * FROM solicitudes ORDER BY id DESC");
    const csv = stringify(result.rows, { header: true });

    return ctx.replyWithDocument({
      source: Buffer.from(csv),
      filename: "reporte.csv",
    });
  }

  /**************** INTENTS ****************/
  if (intent === "Solicitud") {
    const ultima = await getUltimaSolicitud(userId);
    await setEstado(userId, "servicio", {});

    if (ultima) {
      return ctx.reply(
        `🧠 La última vez solicitaste:\n🛠️ ${ultima.servicio}\n📅 ${ultima.fecha}\n\n¿Deseas el mismo servicio o uno diferente?`
      );
    }

    return ctx.reply("¿Qué servicio necesitas?");
  }

  if (intent === "ModificarSolicitud") {
    await setEstado(userId, "modificar_id", {});
    return ctx.reply("🔎 Indica el ID de la solicitud a modificar:");
  }

  if (intent === "CancelarSolicitud") {
    await setEstado(userId, "cancelar_id", {});
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

  /**************** IA ****************/
  const aiReply = await askDeepSeek(text);
  return ctx.reply(aiReply);
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