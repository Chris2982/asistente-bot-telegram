/******************************************************************
 * 🔥 VARIABLES Y CONFIG
 ******************************************************************/
import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";
import pkg from "pg";
import { stringify } from "csv-stringify/sync";

const { Pool } = pkg;

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
 * 🧠 ESTADOS SEPARADOS
 ******************************************************************/
const userState = {}; // clientes
const chatState = {}; // empresas (grupos)

/******************************************************************
 * 🗄️ TABLAS
 ******************************************************************/
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
 * 🤖 START
 ******************************************************************/
bot.start((ctx) => ctx.reply("Hola 👋"));

/******************************************************************
 * 🏢 REGISTRAR EMPRESA (SOLO GRUPOS)
 ******************************************************************/
bot.command("registrar_empresa", async (ctx) => {
  if (ctx.chat.type === "private") {
    return ctx.reply("❌ Este comando solo funciona en grupos.");
  }

  chatState[ctx.chat.id] = { paso: "nombre_empresa" };
  ctx.reply("🏢 Escribe el nombre de la empresa:");
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;

  /**************** EMPRESA EN GRUPO ****************/
  if (chatState[chatId]) {
    const estado = chatState[chatId];

    if (estado.paso === "nombre_empresa") {
      await db.query(
        "INSERT INTO empresas (nombre, chat_id) VALUES ($1,$2) ON CONFLICT (chat_id) DO NOTHING",
        [text, chatId]
      );

      delete chatState[chatId];
      return ctx.reply("✅ Empresa registrada correctamente.");
    }
  }

  /**************** CLIENTE EN PRIVADO ****************/
  if (ctx.chat.type === "private") {
    if (userState[userId]) {
      const estado = userState[userId];

      if (estado.paso === "servicio") {
        estado.servicio = text;
        estado.paso = "fecha";
        return ctx.reply("📅 ¿Para qué fecha?");
      }

      if (estado.paso === "fecha") {
        const empresa = await db.query(
          "SELECT chat_id FROM empresas LIMIT 1"
        );

        if (empresa.rows.length === 0) {
          delete userState[userId];
          return ctx.reply("⚠️ No hay empresas registradas.");
        }

        const empresaChatId = empresa.rows[0].chat_id;

        await db.query(
          "INSERT INTO solicitudes (user_id, empresa_chat_id, servicio, fecha) VALUES ($1,$2,$3,$4)",
          [userId, empresaChatId, estado.servicio, text]
        );

        await bot.telegram.sendMessage(
          empresaChatId,
          `📦 Nuevo pedido:\n👤 Usuario: ${userId}\n🛠️ ${estado.servicio}\n📅 ${text}`
        );

        delete userState[userId];
        return ctx.reply("✅ Tu solicitud fue enviada a la empresa.");
      }
    }

    const intent = await detectIntent(text, userId);

    if (intent === "Solicitud") {
      userState[userId] = { paso: "servicio" };
      return ctx.reply("🛠️ ¿Qué servicio necesitas?");
    }
  }
});

/******************************************************************
 * 🚀 WEBHOOK
 ******************************************************************/
const WEBHOOK_PATH = "/telegram";
app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

async function start() {
  await initDB();
  app.listen(PORT);
}

start();
