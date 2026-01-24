/******************************************************************
 * 🔥 CARGA DE VARIABLES DE ENTORNO
 ******************************************************************/
import "dotenv/config"; // Carga variables de .env
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";
import pkg from "pg";
import { stringify } from "csv-stringify/sync"; // Para generar CSV de reportes

const { Pool } = pkg;

/******************************************************************
 * ⚙️ VARIABLES DE ENTORNO
 ******************************************************************/
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DF_PROJECT_ID = process.env.DF_PROJECT_ID;
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL; // Postgres URL de Render

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
 * ✅ CREAR TABLAS AUTOMÁTICAMENTE
 ******************************************************************/
async function initDB() {
  // Tabla de solicitudes
  await db.query(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      servicio TEXT,
      fecha TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Tabla para guardar interacciones (mensajes/respuestas)
  await db.query(`
    CREATE TABLE IF NOT EXISTS interacciones (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      mensaje TEXT,
      respuesta TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("✅ Tablas 'solicitudes' e 'interacciones' verificadas");
}

/******************************************************************
 * 🌐 APP EXPRESS
 ******************************************************************/
const app = express();
app.use(express.json());

/******************************************************************
 * 🤖 BOT TELEGRAM
 ******************************************************************/
const bot = new Telegraf(TELEGRAM_TOKEN);

/******************************************************************
 * 🧠 MEMORIA EN RAM (FLUJOS)
 ******************************************************************/
const userState = {}; // Para guardar paso actual de cada usuario

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
      queryInput: { text: { text, languageCode: "es" } },
    };

    const [response] = await dfClient.detectIntent(request);
    return response.queryResult.intent?.displayName || "fallback";
  } catch (err) {
    console.error("❌ Dialogflow:", err);
    return "fallback";
  }
}

/******************************************************************
 * 🤖 IA (SOLO FALLBACK)
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
 ******************************************************************/
bot.start((ctx) => {
  ctx.reply(`¡Hola ${ctx.from.first_name}! 👋`);
  ctx.reply("¿En qué puedo ayudarte?");
});

/******************************************************************
 * MENSAJES
 ******************************************************************/
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (text.startsWith("/")) return;

  console.log("📩 MENSAJE:", text);

  /**************************************************************
   * 🔁 FLUJO DE REGISTRO DE SOLICITUD
   **************************************************************/
  if (userState[userId]) {
    const estado = userState[userId];

    if (estado.paso === "servicio") {
      estado.datos.servicio = text;
      estado.paso = "fecha";
      return ctx.reply("📅 ¿Para qué fecha necesitas el servicio?");
    }

    if (estado.paso === "fecha") {
      estado.datos.fecha = text;

      // Guardar en solicitudes
      await db.query(
        "INSERT INTO solicitudes (user_id, servicio, fecha) VALUES ($1, $2, $3)",
        [userId, estado.datos.servicio, estado.datos.fecha]
      );

      const mensaje = `✅ Solicitud registrada:\n🛠️ Servicio: ${estado.datos.servicio}\n📅 Fecha: ${estado.datos.fecha}\n\nUn representante se comunicará contigo.`;

      // Guardar interacción
      await db.query(
        "INSERT INTO interacciones (user_id, mensaje, respuesta) VALUES ($1, $2, $3)",
        [userId, text, mensaje]
      );

      await ctx.reply(mensaje);
      console.log("📦 SOLICITUD GUARDADA:", estado.datos);
      delete userState[userId];
      return;
    }
  }

  /**************************************************************
   * 🧠 DETECTAR INTENCIÓN
   **************************************************************/
  const rawIntent = await detectIntent(text, userId);
  const intent = rawIntent.toLowerCase();
  console.log("🎯 INTENCIÓN:", rawIntent);

  /**************************************************************
   * 🚀 INICIAR SOLICITUD
   **************************************************************/
  if (rawIntent === "Solicitud") {
    userState[userId] = { paso: "servicio", datos: {} };
    return ctx.reply("📋 Perfecto.\n🛠️ ¿Qué servicio necesitas?");
  }

  /**************************************************************
   * 📋 CONSULTAR SOLICITUDES (TOP 5)
   **************************************************************/
  if (rawIntent === "ConsultarSolicitudes") {
    try {
      const result = await db.query(
        "SELECT servicio, fecha FROM solicitudes ORDER BY id DESC LIMIT 5"
      );

      if (result.rows.length === 0) {
        return ctx.reply("📭 No hay solicitudes registradas aún.");
      }

      let mensaje = "📋 Últimas solicitudes registradas:\n\n";
      result.rows.forEach((row, index) => {
        mensaje += `${index + 1}️⃣ ${row.servicio} - ${row.fecha}\n`;
      });

      return ctx.reply(mensaje);
    } catch (error) {
      console.error("❌ Error consultando solicitudes:", error);
      return ctx.reply("⚠️ Error al consultar las solicitudes.");
    }
  }

  /**************************************************************
   * 📊 GENERAR REPORTE CSV (ADMIN)
   **************************************************************/
  if (intent.includes("reporte")) {
    try {
      const result = await db.query(
        "SELECT user_id, servicio, fecha, created_at FROM solicitudes ORDER BY id DESC"
      );

      if (result.rows.length === 0) {
        return ctx.reply("📭 No hay solicitudes para generar reporte.");
      }

      const csv = stringify(result.rows, {
        header: true,
        columns: {
          user_id: "Usuario",
          servicio: "Servicio",
          fecha: "Fecha",
          created_at: "Creado en",
        },
      });

      // Enviar CSV como archivo
      await ctx.replyWithDocument({
        source: Buffer.from(csv),
        filename: "reporte_solicitudes.csv",
      });

      return;
    } catch (error) {
      console.error("❌ Error generando reporte:", error);
      return ctx.reply("⚠️ Error al generar reporte.");
    }
  }

  if (intent === "info") {
    return ctx.reply("ℹ️ Brindamos información general sobre nuestros servicios.");
  }

  if (intent === "support") {
    return ctx.reply("🛠️ Soporte técnico: soporte@tudominio.com");
  }

  /**************************************************************
   * 🤖 FALLBACK IA
   **************************************************************/
  const aiReply = await askDeepSeek(text);

  // Guardar interacción de fallback
  await db.query(
    "INSERT INTO interacciones (user_id, mensaje, respuesta) VALUES ($1, $2, $3)",
    [userId, text, aiReply]
  );

  return ctx.reply(aiReply);
});

/******************************************************************
 * 🔁 WEBHOOK (RENDER)
 ******************************************************************/
const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`;
app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

/******************************************************************
 * 🚀 INICIAR SERVIDOR Y TABLAS
 ******************************************************************/
async function start() {
  await initDB(); // Crea tablas automáticamente

  bot.telegram.setWebhook(WEBHOOK_URL).then(() => {
    console.log("🚀 Webhook activo:", WEBHOOK_URL);
  });

  app.get("/ping", (req, res) => res.send("pong"));

  app.listen(PORT, () => {
    console.log(`🌐 Servidor activo en puerto ${PORT}`);
  });
}

start();