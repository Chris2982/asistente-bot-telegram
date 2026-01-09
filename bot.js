/******************************************************************
 * 🔥 CARGA DE VARIABLES DE ENTORNO
 ******************************************************************/
import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";

/******************************************************************
 * ⚙️ VARIABLES DE ENTORNO
 ******************************************************************/
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DF_PROJECT_ID = process.env.DF_PROJECT_ID;
const PORT = process.env.PORT || 3001;

if (!TELEGRAM_TOKEN) console.error("❌ FALTA TELEGRAM_TOKEN");
if (!DEEPSEEK_API_KEY) console.error("❌ FALTA DEEPSEEK_API_KEY");
if (!DF_PROJECT_ID) console.error("❌ FALTA DF_PROJECT_ID");

/******************************************************************
 * 🌐 APP EXPRESS
 ******************************************************************/
const app = express(); // ❌ NO usamos express.json() global

/******************************************************************
 * 🤖 BOT TELEGRAM
 ******************************************************************/
const bot = new Telegraf(TELEGRAM_TOKEN);

/******************************************************************
 * 🤖 CLIENTE DIALOGFLOW
 ******************************************************************/
const dfClient = new dialogflow.SessionsClient();

/******************************************************************
 * 🧠 DETECTAR INTENCIÓN (DIALOGFLOW)
 ******************************************************************/
async function detectIntent(text, sessionId) {
  try {
    const sessionPath = dfClient.projectAgentSessionPath(
      DF_PROJECT_ID,
      sessionId.toString()
    );

    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text,
          languageCode: "es"
        }
      }
    };

    const [response] = await dfClient.detectIntent(request);
    return (
      response.queryResult.intent?.displayName ||
      "Default Fallback Intent"
    );
  } catch (error) {
    console.error("❌ Error Dialogflow:", error);
    return "Default Fallback Intent";
  }
}

/******************************************************************
 * 🤖 IA (DEEPSEEK) — SOLO FALLBACK
 ******************************************************************/
async function askDeepSeek(text) {
  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "deepseek/deepseek-chat",
          temperature: 0.3,
          max_tokens: 160,
          messages: [
            {
              role: "system",
              content:
                "Eres un asistente empresarial. Responde solo en español. Máximo 3 líneas."
            },
            { role: "user", content: text }
          ]
        })
      }
    );

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "No pude responder.";
  } catch (error) {
    console.error("❌ Error IA:", error);
    return "⚠ Error con la IA.";
  }
}

/******************************************************************
 * /start
 ******************************************************************/
bot.start((ctx) => {
  ctx.reply(`¡Hola ${ctx.from.first_name}! 👋`);
  ctx.reply("Escribe tu consulta 🙂");
});

/******************************************************************
 * MENSAJES DE TEXTO
 ******************************************************************/
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  console.log("📩 MENSAJE TELEGRAM:", text);

  const intent = await detectIntent(text, ctx.from.id);
  console.log("🎯 INTENCIÓN DETECTADA:", intent);

  if (intent === "info") {
    return ctx.reply(
      "ℹ️ Brindamos información general sobre nuestros servicios."
    );
  }

  if (intent === "support") {
    return ctx.reply(
      "🛠️ Soporte técnico: soporte@tudominio.com"
    );
  }

  const aiReply = await askDeepSeek(text);
  return ctx.reply(aiReply);
});

/******************************************************************
 * 🚀 PRODUCCIÓN — WEBHOOK (RENDER)
 ******************************************************************/
if (process.env.RENDER) {
  const WEBHOOK_PATH = "/telegram";
  const WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`;

  // ✅ JSON SOLO PARA EL WEBHOOK
  app.use(WEBHOOK_PATH, express.json());
  app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

  bot.telegram.setWebhook(WEBHOOK_URL);

  app.listen(PORT, () => {
    console.log("🚀 BOT EN PRODUCCIÓN (WEBHOOK)");
    console.log("🌐 Webhook:", WEBHOOK_URL);
  });
}

/******************************************************************
 * 🧪 LOCAL — POLLING
 ******************************************************************/
if (!process.env.RENDER) {
  bot.launch();
  app.listen(PORT, () => {
    console.log("🤖 BOT EN LOCAL (POLLING)");
    console.log(`🌐 Puerto ${PORT}`);
  });
}

/******************************************************************
 * 🔎 PING DE PRUEBA
 ******************************************************************/
app.get("/ping", (req, res) => {
  console.log("📡 Ping recibido");
  res.send("pong");
});
