import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";
import pkg from "pg";
import { stringify } from "csv-stringify/sync";

const { Pool } = pkg;

/**************** VARIABLES ****************/
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DF_PROJECT_ID = process.env.DF_PROJECT_ID;
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL;

/**************** DB ****************/
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/**************** EXPRESS ****************/
const app = express();
app.use(express.json());

/**************** BOT ****************/
const bot = new Telegraf(TELEGRAM_TOKEN);
const dfClient = new dialogflow.SessionsClient();

/**************** ESTADOS ****************/
const userState = {};
const chatState = {};

/**************** TABLAS ****************/
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id SERIAL PRIMARY KEY,
      nombre TEXT,
      chat_id BIGINT UNIQUE
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      empresa_chat_id BIGINT,
      servicio TEXT,
      fecha TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**************** INTENT ****************/
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

/**************** IA ****************/
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

/**************** START ****************/
bot.start((ctx) => ctx.reply("Hola 👋"));

/**************** REGISTRAR EMPRESA EN GRUPO ****************/
bot.command("registrar_empresa", async (ctx) => {
  if (ctx.chat.type === "private") {
    return ctx.reply("❌ Usa este comando en el grupo de la empresa.");
  }
  chatState[ctx.chat.id] = { paso: "nombre_empresa" };
  ctx.reply("🏢 Escribe el nombre de la empresa:");
});

/**************** MENSAJES ****************/
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;

  /*************** REGISTRO EMPRESA ***************/
  if (chatState[chatId]) {
    await db.query(
      "INSERT INTO empresas (nombre, chat_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [text, chatId]
    );
    delete chatState[chatId];
    return ctx.reply("✅ Empresa registrada correctamente.");
  }

  /*************** FLUJOS EN CURSO ***************/
  if (userState[userId]) {
    const estado = userState[userId];

    if (estado.paso === "servicio") {
      estado.servicio = text;
      estado.paso = "fecha";
      return ctx.reply("📅 ¿Para qué fecha?");
    }

    if (estado.paso === "fecha") {
      const empresa = await db.query("SELECT chat_id FROM empresas LIMIT 1");
      const empresaChatId = empresa.rows[0]?.chat_id;

      await db.query(
        "INSERT INTO solicitudes (user_id, empresa_chat_id, servicio, fecha) VALUES ($1,$2,$3,$4)",
        [userId, empresaChatChatId, estado.servicio, text]
      );

      await bot.telegram.sendMessage(
        empresaChatId,
        `📦 Nuevo pedido\n👤 ${userId}\n🛠️ ${estado.servicio}\n📅 ${text}`
      );

      delete userState[userId];
      return ctx.reply("✅ Tu solicitud fue enviada.");
    }
  }

  /*************** REPORTE ***************/
  if (text.toLowerCase() === "reporte") {
    const result = await db.query("SELECT * FROM solicitudes");
    const csv = stringify(result.rows, { header: true });

    return ctx.replyWithDocument({
      source: Buffer.from(csv),
      filename: "reporte.csv",
    });
  }

  /*************** INTENTS ***************/
  const intent = await detectIntent(text, userId);

  if (intent === "Solicitud") {
    userState[userId] = { paso: "servicio" };
    return ctx.reply("🛠️ ¿Qué servicio necesitas?");
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

  /*************** IA ***************/
  const aiReply = await askDeepSeek(text);
  return ctx.reply(aiReply);
});

/**************** WEBHOOK ****************/
const WEBHOOK_PATH = "/telegram";
app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

async function start() {
  await initDB();
  app.listen(PORT);
}

start();