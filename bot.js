Mi niimport "dotenv/config";
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
 * 🧠 ESTADO
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
 * 🧠 MEMORIA
 ******************************************************************/
const getUltimaSolicitud = async (userId) => {
  const r = await db.query(
    "SELECT servicio, fecha FROM solicitudes WHERE user_id=$1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return r.rows[0] || null;
};

const getSolicitudesUsuario = async (userId) => {
  const r = await db.query(
    "SELECT servicio, fecha FROM solicitudes WHERE user_id=$1 ORDER BY id DESC LIMIT 5",
    [userId]
  );
  return r.rows;
};

/******************************************************************
 * 🧠 INTENT
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
 * 🤖 IA CON CONTEXTO
 ******************************************************************/
async function buildContextPrompt(userId, userMessage) {
  const estado = await getEstado(userId);
  const solicitudes = await getSolicitudesUsuario(userId);

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

async function askDeepSeek(userId, text) {
  const prompt = await buildContextPrompt(userId, text);

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
 * START
 ******************************************************************/
bot.start((ctx) => {
  ctx.reply(`¡Hola ${ctx.from.first_name}! 👋`);
});

/******************************************************************
 * MENSAJES
 ******************************************************************/
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();
  const userId = ctx.from.id;

  console.log("👤", userId, "💬", text);

  if (lower === "hola") {
    return ctx.reply(`¡Hola ${ctx.from.first_name}! ¿En qué puedo ayudarte?`);
  }

  const intent = await detectIntent(text, userId);
  console.log("🧠 Intent:", intent);

  /**************** INTENTS PRIMERO ****************/

  const intentsPrincipales = [
    "Solicitud",
    "ModificarSolicitud",
    "CancelarSolicitud",
    "ConsultarSolicitudes",
  ];

  if (intentsPrincipales.includes(intent)) {
    await clearEstado(userId);

    if (intent === "Solicitud") {
      const ultima = await getUltimaSolicitud(userId);
      await setEstado(userId, "servicio", {});
      if (ultima) {
        return ctx.reply(
          `La última vez solicitaste:\n${ultima.servicio} - ${ultima.fecha}\n\n¿Qué servicio necesitas ahora?`
        );
      }
      return ctx.reply("¿Qué servicio necesitas?");
    }

    if (intent === "ModificarSolicitud") {
      await setEstado(userId, "modificar_id", {});
      return ctx.reply("Indica el ID de la solicitud a modificar:");
    }

    if (intent === "CancelarSolicitud") {
      await setEstado(userId, "cancelar_id", {});
      return ctx.reply("Indica el ID de la solicitud a cancelar:");
    }

    if (intent === "ConsultarSolicitudes") {
      const r = await db.query(
        "SELECT id, servicio, fecha FROM solicitudes ORDER BY id DESC LIMIT 5"
      );
      let msg = "Últimas solicitudes:\n\n";
      r.rows.forEach((s) => {
        msg += `ID ${s.id} | ${s.servicio} | ${s.fecha}\n`;
      });
      return ctx.reply(msg);
    }
  }

  /**************** ESTADO ****************/

  const estado = await getEstado(userId);

  if (estado) {
    const datos = estado.datos || {};

    if (estado.paso === "servicio") {
      datos.servicio = text;
      await setEstado(userId, "fecha", datos);
      return ctx.reply("¿Para qué fecha?");
    }

    if (estado.paso === "fecha") {
      await db.query(
        "INSERT INTO solicitudes (user_id, servicio, fecha) VALUES ($1,$2,$3)",
        [userId, datos.servicio, text]
      );
      await clearEstado(userId);
      return ctx.reply("Solicitud registrada correctamente ✅");
    }

    if (estado.paso === "modificar_id") {
      await setEstado(userId, "modificar_servicio", { id: text });
      return ctx.reply("Nuevo servicio:");
    }

    if (estado.paso === "modificar_servicio") {
      datos.servicio = text;
      await setEstado(userId, "modificar_fecha", datos);
      return ctx.reply("Nueva fecha:");
    }

    if (estado.paso === "modificar_fecha") {
      await db.query(
        "UPDATE solicitudes SET servicio=$1, fecha=$2 WHERE id=$3",
        [datos.servicio, text, datos.id]
      );
      await clearEstado(userId);
      return ctx.reply("Solicitud modificada ✅");
    }

    if (estado.paso === "cancelar_id") {
      await db.query("DELETE FROM solicitudes WHERE id=$1", [text]);
      await clearEstado(userId);
      return ctx.reply("Solicitud cancelada 🗑️");
    }
  }

  /**************** REPORTE ****************/

  if (lower === "reporte") {
    const r = await db.query("SELECT * FROM solicitudes");
    const csv = stringify(r.rows, { header: true });
    return ctx.replyWithDocument({
      source: Buffer.from(csv),
      filename: "reporte.csv",
    });
  }

  /**************** IA ****************/
  const ai = await askDeepSeek(userId, text);
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