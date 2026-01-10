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

if (!TELEGRAM_TOKEN) throw new Error("❌ FALTA TELEGRAM_TOKEN");
if (!DEEPSEEK_API_KEY) throw new Error("❌ FALTA DEEPSEEK_API_KEY");
if (!DF_PROJECT_ID) throw new Error("❌ FALTA DF_PROJECT_ID");

/******************************************************************
 * 🌐 APP EXPRESS
 ******************************************************************/
const app = express();
app.use(express.json()); // ⚠️ OBLIGATORIO PARA WEBHOOK

/******************************************************************
 * 🤖 BOT TELEGRAM
 ******************************************************************/
const bot = new Telegraf(TELEGRAM_TOKEN);

/******************************************************************
 * 🤖 CLIENTE DIALOGFLOW
 ******************************************************************/
const dfClient = new dialogflow.SessionsClient();

/******************************************************************
 * 🧠 DETECTAR INTENCIÓN
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
    return response.queryResult.intent?.displayName || "Default Fallback Intent";
  } catch (err) {
    console.error("❌ Error Dialogflow:", err);
    return "Default Fallback Intent";
  }
}

/******************************************************************
 * 🤖 IA — FALLBACK
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
    return "⚠️ Error con la IA.";
  }
}

/******************************************************************
 * COMANDOS
 ******************************************************************/
bot.start((ctx) => {
  ctx.reply(`¡Hola ${ctx.from.first_name}! 👋`);
  ctx.reply("Escribe tu consulta 🙂");
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text;

  // Ignorar comandos
  if (text.startsWith("/")) return;

  console.log("📩 MENSAJE:", text);

  // 1️⃣ Detectar intención con Dialogflow
  const intent = await detectIntent(text, ctx.from.id);
  console.log("🎯 INTENCIÓN:", intent);

  // 2️⃣ Respuestas controladas (flujos de negocio)
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

  if (intent === "Solicitud") {
    return ctx.reply(
      "📋 Hemos recibido tu solicitud.\n" +
      "Un representante del negocio se comunicará contigo en breve."
    );
  }

  // 3️⃣ Fallback → IA (solo si no hay intención clara)
  const aiReply = await askDeepSeek(text);
  return ctx.reply(aiReply);
});

/******************************************************************
 * 🔁 WEBHOOK (RENDER)
 ******************************************************************/
const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`;

app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

bot.telegram.setWebhook(WEBHOOK_URL).then(() => {
  console.log("🚀 WEBHOOK REGISTRADO:", WEBHOOK_URL);
});

/******************************************************************
 * 🔎 PING
 ******************************************************************/
app.get("/ping", (req, res) => {
  res.send("pong");
});

/******************************************************************
 * 🚀 INICIAR SERVIDOR
 ******************************************************************/
app.listen(PORT, () => {
  console.log(`🌐 SERVIDOR ACTIVO EN PUERTO ${PORT}`);
});
