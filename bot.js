/******************************************************************
 * 🔥 CARGA DE VARIABLES DE ENTORNO
 * Importa las variables definidas en tu archivo .env
 ******************************************************************/
import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";
import pkg from "pg";

const { Pool } = pkg; // Importamos el Pool de PostgreSQL para manejar la conexión.

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
 * 🗄️ CONEXIÓN POSTGRESQL (RENDER)
 * Se conecta a la base de datos usando la URL de Render
 ******************************************************************/
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Necesario en Render para SSL
});

/******************************************************************
 * ✅ CREAR TABLA AUTOMÁTICAMENTE
 * Verifica si la tabla 'solicitudes' existe y si no, la crea.
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
  console.log("✅ Tabla 'solicitudes' verificada");
}

/******************************************************************
 * 🌐 APP EXPRESS
 * Configura el servidor web mínimo
 ******************************************************************/
const app = express();
app.use(express.json());

/******************************************************************
 * 🤖 BOT TELEGRAM
 ******************************************************************/
const bot = new Telegraf(TELEGRAM_TOKEN);

/******************************************************************
 * 🧠 MEMORIA EN RAM (FLUJOS)
 * Guarda temporalmente el estado de cada usuario
 ******************************************************************/
const userState = {};

/******************************************************************
 * 🤖 CLIENTE DIALOGFLOW
 * Para detectar la intención del mensaje
 ******************************************************************/
const dfClient = new dialogflow.SessionsClient();

/******************************************************************
 * 🧠 DETECTAR INTENCIÓN
 * Función para enviar el texto a Dialogflow y obtener la intención
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
        text: { text, languageCode: "es" },
      },
    };

    const [response] = await dfClient.detectIntent(request);
    return response.queryResult.intent?.displayName || "fallback";
  } catch (err) {
    console.error("❌ Dialogflow:", err);
    return "fallback";
  }
}

/******************************************************************
 * 🤖 FALLBACK IA (DeepSeek)
 * Responde cuando Dialogflow no reconoce la intención
 ******************************************************************/
async function askDeepSeek(text) {
  try {
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
          temperature: 0.3,
          max_tokens: 160,
          messages: [
            {
              role: "system",
              content:
                "Eres un asistente empresarial. Responde solo en español. Máximo 3 líneas.",
            },
            { role: "user", content: text },
          ],
        }),
      }
    );

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "No pude responder.";
  } catch (err) {
    console.error("❌ IA:", err);
    return "⚠️ Error con la IA.";
  }
}

/******************************************************************
 * /start
 * Saluda al usuario cuando inicia la conversación
 ******************************************************************/
bot.start((ctx) => {
  ctx.reply(`¡Hola ${ctx.from.first_name}! 👋`);
  ctx.reply("¿En qué puedo ayudarte?");
});

/******************************************************************
 * MENSAJES
 * Maneja todos los mensajes de texto del usuario
 ******************************************************************/
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (text.startsWith("/")) return; // Ignora comandos especiales

  console.log("📩 MENSAJE:", text);

  // 🔁 Flujos de usuario en memoria RAM
  if (userState[userId]) {
    const estado = userState[userId];

    // PASO 1: Servicio
    if (estado.paso === "servicio") {
      estado.datos.servicio = text;
      estado.paso = "fecha";
      return ctx.reply("📅 ¿Para qué fecha necesitas el servicio?");
    }

    // PASO 2: Fecha
    if (estado.paso === "fecha") {
      estado.datos.fecha = text;

      // 💾 Guardar en PostgreSQL
      await db.query(
        "INSERT INTO solicitudes (user_id, servicio, fecha) VALUES ($1, $2, $3)",
        [userId, estado.datos.servicio, estado.datos.fecha]
      );

      await ctx.reply(
        "✅ Solicitud registrada:\n" +
          `🛠️ Servicio: ${estado.datos.servicio}\n` +
          `📅 Fecha: ${estado.datos.fecha}\n\n` +
          "Un representante del negocio se comunicará contigo."
      );

      console.log("📦 SOLICITUD GUARDADA:", estado.datos);
      delete userState[userId];
      return;
    }
  }

  // 🧠 Detectar intención con Dialogflow
  const rawIntent = await detectIntent(text, userId);
  const intent = rawIntent.toLowerCase();

  console.log("🎯 INTENCIÓN:", rawIntent);

  // 🚀 Iniciar flujo de solicitud
  if (rawIntent === "Solicitud") {
    userState[userId] = { paso: "servicio", datos: {} };
    return ctx.reply("📋 Perfecto.\n🛠️ ¿Qué servicio necesitas?");
  }

  // 📋 Consultar últimas solicitudes
  if (rawIntent === "ConsultarSolicitudes") {
    try {
      const result = await db.query(
        "SELECT servicio, fecha, created_at FROM solicitudes ORDER BY id DESC LIMIT 5"
      );

      if (result.rows.length === 0) {
        return ctx.reply("📭 No hay solicitudes registradas aún.");
      }

      let mensaje = "📋 Últimas solicitudes registradas:\n\n";

      result.rows.forEach((row, index) => {
        mensaje += `${index + 1}️⃣ 🛠️ ${row.servicio} - 📅 ${row.fecha} (🕒 ${row.created_at.toLocaleString()})\n`;
      });

      return ctx.reply(mensaje);
    } catch (error) {
      console.error("❌ Error consultando solicitudes:", error);
      return ctx.reply("⚠️ Error al consultar las solicitudes.");
    }
  }

  // ℹ️ Información general
  if (intent === "info") {
    return ctx.reply("ℹ️ Brindamos información general sobre nuestros servicios.");
  }

  // 🛠️ Soporte técnico
  if (intent === "support") {
    return ctx.reply("🛠️ Soporte técnico: soporte@tudominio.com");
  }

  // Fallback a IA
  const aiReply = await askDeepSeek(text);
  return ctx.reply(aiReply);
});

/******************************************************************
 * 🔁 WEBHOOK (RENDER)
 ******************************************************************/
const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`;

app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

/******************************************************************
 * 🚀 INICIAR SERVIDOR Y BASE DE DATOS
 ******************************************************************/
async function start() {
  await initDB(); // Crea la tabla si no existe

  bot.telegram.setWebhook(WEBHOOK_URL).then(() => {
    console.log("🚀 Webhook activo:", WEBHOOK_URL);
  });

  app.get("/ping", (req, res) => res.send("pong"));

  app.listen(PORT, () => {
    console.log(`🌐 Servidor activo en puerto ${PORT}`);
  });
}

start();