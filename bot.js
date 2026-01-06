/******************************************************************
 * 🔥 CARGA DE VARIABLES DE ENTORNO
 ******************************************************************/
import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";

/******************************************************************
 * ⚙️ CONFIGURACIÓN GENERAL
 ******************************************************************/
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DF_PROJECT_ID = process.env.DF_PROJECT_ID;

if (!TELEGRAM_TOKEN) console.error("❌ FALTA TELEGRAM_TOKEN");
if (!DEEPSEEK_API_KEY) console.error("❌ FALTA DEEPSEEK_API_KEY");
if (!DF_PROJECT_ID) console.error("❌ FALTA DF_PROJECT_ID");

/******************************************************************
 * 🤖 CLIENTE DIALOGFLOW (SDK OFICIAL)
 ******************************************************************/
const dfClient = new dialogflow.SessionsClient();

/******************************************************************
 * 🧠 DETECTAR INTENCIÓN CON DIALOGFLOW (PASO 9 REAL)
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

    const responses = await dfClient.detectIntent(request);
    const result = responses[0].queryResult;

    return result.intent?.displayName || "Default Fallback Intent";
  } catch (err) {
    console.error("❌ Error Dialogflow:", err);
    return "Default Fallback Intent";
  }
}

/******************************************************************
 * 🤖 FUNCIÓN IA — SOLO FALLBACK
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
  } catch (err) {
    console.error("❌ Error IA:", err);
    return "⚠ Error con la IA.";
  }
}

/******************************************************************
 * 🤖 BOT TELEGRAM
 ******************************************************************/
const bot = new Telegraf(TELEGRAM_TOKEN);

/******************************************************************
 * /start
 ******************************************************************/
bot.start(async (ctx) => {
  await ctx.reply(
    `¡Hola ${ctx.from.first_name}! 👋\nSoy tu asistente empresarial.`
  );
  await ctx.reply("Escribe tu consulta 🙂");
});

/******************************************************************
 * TEXTO NORMAL — FLUJO PASO 9
 ******************************************************************/
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  console.log("📩 MENSAJE TELEGRAM:", text);

  // 1️⃣ Dialogflow detecta intención
  const intent = await detectIntent(text, ctx.from.id);

  console.log("🎯 INTENCIÓN DETECTADA:", intent);

  // 2️⃣ Respuestas controladas
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

  // 3️⃣ Fallback IA
  const aiReply = await askDeepSeek(text);
  return ctx.reply(aiReply);
});

/******************************************************************
 * 🚀 LANZAR BOT
 ******************************************************************/
(async () => {
  try {
    await bot.launch();
    console.log("🤖 BOT DE TELEGRAM LISTO PARA USARSE");
  } catch (err) {
    console.error("❌ Error iniciando bot:", err);
  }
})();

/******************************************************************
 * 🌐 EXPRESS — SOLO TEST
 ******************************************************************/
const app = express();

app.get("/ping", (req, res) => {
  console.log("📡 Ping recibido");
  res.send("pong");
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🌐 SERVIDOR EXPRESS ACTIVO EN PUERTO ${PORT}`);
});
