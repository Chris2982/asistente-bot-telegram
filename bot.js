import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import dialogflow from "@google-cloud/dialogflow";
import pkg from "pg";
import { stringify } from "csv-stringify/sync";

const { Pool } = pkg;

/******************************************************************
 VARIABLES
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
 TABLAS
******************************************************************/

async function initDB() {

  await db.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id SERIAL PRIMARY KEY,
      nombre TEXT,
      codigo TEXT,
      telegram_id BIGINT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      empresa_id INTEGER,
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
 ESTADO CONVERSACIÓN
******************************************************************/

const getEstado = async (userId) => {

  const r = await db.query(
    "SELECT paso,datos FROM estados_conversacion WHERE user_id=$1",
    [userId]
  );

  return r.rows[0] || null;

};

const setEstado = async (userId,paso,datos={}) => {

  await db.query(
`INSERT INTO estados_conversacion (user_id,paso,datos)
VALUES ($1,$2,$3)
ON CONFLICT (user_id)
DO UPDATE SET paso=$2,datos=$3,updated_at=CURRENT_TIMESTAMP`,
[userId,paso,datos]
);

};

const clearEstado = async (userId)=>{
  await db.query("DELETE FROM estados_conversacion WHERE user_id=$1",[userId]);
};

/******************************************************************
 MEMORIA
******************************************************************/

const getUltimaSolicitud = async (userId,empresaId)=>{

  const r = await db.query(
"SELECT servicio,fecha FROM solicitudes WHERE user_id=$1 AND empresa_id=$2 ORDER BY id DESC LIMIT 1",
[userId,empresaId]
);

return r.rows[0] || null;

};

const getSolicitudesUsuario = async (userId,empresaId)=>{

  const r = await db.query(
"SELECT servicio,fecha FROM solicitudes WHERE user_id=$1 AND empresa_id=$2 ORDER BY id DESC LIMIT 5",
[userId,empresaId]
);

return r.rows;

};

/******************************************************************
 INTENT
******************************************************************/

async function detectIntent(text,sessionId){

try{

const sessionPath = dfClient.projectAgentSessionPath(
DF_PROJECT_ID,
sessionId.toString()
);

const [response] = await dfClient.detectIntent({
session:sessionPath,
queryInput:{text:{text,languageCode:"es"}}
});

return response.queryResult.intent?.displayName || "fallback";

}catch{
return "fallback";
}

}

/******************************************************************
 IA
******************************************************************/

async function buildContextPrompt(userId,empresaId,userMessage){

const estado = await getEstado(userId);
const solicitudes = await getSolicitudesUsuario(userId,empresaId);

let historial="";

solicitudes.forEach((s,i)=>{
historial+=`${i+1}. Servicio:${s.servicio}, Fecha:${s.fecha}\n`
});

return `Eres asistente de solicitudes.

Historial:
${historial || "Sin historial"}

Estado:${estado?.paso || "ninguno"}

Mensaje:${userMessage}`;

}

async function askDeepSeek(userId,empresaId,text){

const prompt = await buildContextPrompt(userId,empresaId,text);

const response = await fetch(
"https://openrouter.ai/api/v1/chat/completions",
{
method:"POST",
headers:{
Authorization:`Bearer ${DEEPSEEK_API_KEY}`,
"Content-Type":"application/json"
},
body:JSON.stringify({
model:"deepseek/deepseek-chat",
messages:[{role:"user",content:prompt}]
})
}
);

const data = await response.json();

return data.choices?.[0]?.message?.content || "No pude responder";

}

/******************************************************************
 EMPRESAS
******************************************************************/

async function mostrarEmpresas(ctx){

const r = await db.query("SELECT id,nombre FROM empresas");

if(r.rows.length===0){
return ctx.reply("No hay empresas registradas");
}

const botones = r.rows.map(e=>[
{ text:e.nombre, callback_data:`empresa_${e.id}` }
]);

return ctx.reply(
"Selecciona empresa",
{reply_markup:{inline_keyboard:botones}}
);

}

bot.action(/empresa_(.+)/, async ctx=>{

const empresaId = ctx.match[1];
const userId = ctx.from.id;

const r = await db.query(
"SELECT nombre FROM empresas WHERE id=$1",
[empresaId]
);

await setEstado(userId,"empresa_seleccionada",{empresa_id:empresaId});

await ctx.answerCbQuery();

ctx.reply(`Empresa seleccionada: ${r.rows[0].nombre}`);

});

/******************************************************************
 RESPUESTA EMPRESA
******************************************************************/

bot.action(/aceptar_(.+)/, async ctx=>{

const solicitudId = ctx.match[1];

const r = await db.query(
"SELECT user_id,servicio,fecha FROM solicitudes WHERE id=$1",
[solicitudId]
);

const solicitud = r.rows[0];

await bot.telegram.sendMessage(
solicitud.user_id,
`Tu solicitud fue aceptada

Servicio:${solicitud.servicio}
Fecha:${solicitud.fecha}`
);

await ctx.answerCbQuery("Aceptada");

ctx.editMessageText("Solicitud aceptada");

});

bot.action(/rechazar_(.+)/, async ctx=>{

const solicitudId = ctx.match[1];

const r = await db.query(
"SELECT user_id,servicio,fecha FROM solicitudes WHERE id=$1",
[solicitudId]
);

const solicitud = r.rows[0];

await bot.telegram.sendMessage(
solicitud.user_id,
`Tu solicitud fue rechazada

Servicio:${solicitud.servicio}
Fecha:${solicitud.fecha}`
);

await ctx.answerCbQuery("Rechazada");

ctx.editMessageText("Solicitud rechazada");

});

/******************************************************************
 ACCIONES CLIENTE
******************************************************************/

bot.action(/modificar_(.+)/, async ctx=>{

const solicitudId = ctx.match[1];
const userId = ctx.from.id;

await setEstado(userId,"modificar_fecha",{solicitud_id:solicitudId});

await ctx.answerCbQuery();

ctx.reply("Escribe la nueva fecha");

});

bot.action(/cancelar_(.+)/, async ctx=>{

const solicitudId = ctx.match[1];

await db.query(
"DELETE FROM solicitudes WHERE id=$1",
[solicitudId]
);

await ctx.answerCbQuery();

ctx.editMessageText("Solicitud cancelada");

});

/******************************************************************
 START
******************************************************************/

bot.start(async ctx=>{

ctx.reply(`Hola ${ctx.from.first_name}`);

await mostrarEmpresas(ctx);

});

/******************************************************************
 MENSAJES
******************************************************************/

bot.on("text", async ctx=>{

const text = ctx.message.text.trim();
const userId = ctx.from.id;

console.log("👤",userId,"💬",text);

/**************** COMANDOS ****************/

if(text.startsWith("/crear_empresa")){

const partes = text.split(" ");
const nombre = partes[1];
const codigo = partes[2];

await db.query(
"INSERT INTO empresas (nombre,codigo) VALUES ($1,$2)",
[nombre,codigo]
);

return ctx.reply("Empresa creada");

}

if(text.startsWith("/soy_empresa")){

const codigo = text.split(" ")[1];

const r = await db.query(
"SELECT id FROM empresas WHERE codigo=$1",
[codigo]
);

if(r.rows.length===0){
return ctx.reply("Código inválido");
}

await db.query(
"UPDATE empresas SET telegram_id=$1 WHERE id=$2",
[userId,r.rows[0].id]
);

return ctx.reply("Empresa vinculada");

}

if (text.toLowerCase() === "reporte") {

  const estadoEmpresa = await getEstado(userId);
  const empresaId = estadoEmpresa?.datos?.empresa_id;

  if (!empresaId) {
    return ctx.reply("Primero selecciona una empresa.");
  }

  const r = await db.query(
    "SELECT id, servicio, fecha, user_id, created_at FROM solicitudes WHERE empresa_id=$1 ORDER BY id DESC",
    [empresaId]
  );

  if (r.rows.length === 0) {
    return ctx.reply("No hay solicitudes para generar reporte.");
  }

  const csv = stringify(r.rows, {
    header: true,
    columns: ["id", "servicio", "fecha", "user_id", "created_at"],
  });

  return ctx.replyWithDocument({
    source: Buffer.from(csv),
    filename: "reporte_solicitudes.csv",
  });

}

/**************** EMPRESA ****************/

const estadoEmpresa = await getEstado(userId);
const empresaId = estadoEmpresa?.datos?.empresa_id;

if(!empresaId){
return mostrarEmpresas(ctx);
}

/**************** INTENT ****************/

const intent = await detectIntent(text,userId);

if(intent==="Solicitud"){

await setEstado(userId,"servicio",{empresa_id:empresaId});

return ctx.reply("¿Qué servicio necesitas?");

}

if(intent==="ConsultarSolicitudes"){

const r = await db.query(
"SELECT id,servicio,fecha FROM solicitudes WHERE user_id=$1 AND empresa_id=$2 ORDER BY id DESC",
[userId,empresaId]
);

const botones = r.rows.map(s=>[
{ text:`✏️ ${s.servicio} - ${s.fecha}`, callback_data:`modificar_${s.id}` },
{ text:"❌ Cancelar", callback_data:`cancelar_${s.id}` }
]);

return ctx.reply(
"Tus solicitudes",
{reply_markup:{inline_keyboard:botones}}
);

}

/**************** ESTADOS ****************/

const estado = await getEstado(userId);

if(estado){

const datos = estado.datos || {};

if(estado.paso==="servicio"){

datos.servicio=text;

await setEstado(userId,"fecha",datos);

return ctx.reply("¿Para qué fecha?");

}

if(estado.paso==="fecha"){

const result = await db.query(
"INSERT INTO solicitudes (user_id,empresa_id,servicio,fecha) VALUES ($1,$2,$3,$4) RETURNING id",
[userId,empresaId,datos.servicio,text]
);

const solicitudId = result.rows[0].id;

const empresa = await db.query(
"SELECT telegram_id FROM empresas WHERE id=$1",
[empresaId]
);

if(empresa.rows[0]?.telegram_id){

await bot.telegram.sendMessage(
empresa.rows[0].telegram_id,
`Nueva solicitud

Servicio:${datos.servicio}
Fecha:${text}

ID:${solicitudId}`,
{
reply_markup:{
inline_keyboard:[[
{ text:"Aceptar", callback_data:`aceptar_${solicitudId}` },
{ text:"Rechazar", callback_data:`rechazar_${solicitudId}` }
]]
}
}
);

}

await clearEstado(userId);

return ctx.reply("Solicitud registrada");

}

if(estado.paso==="modificar_fecha"){

await db.query(
"UPDATE solicitudes SET fecha=$1 WHERE id=$2",
[text,estado.datos.solicitud_id]
);

await clearEstado(userId);

return ctx.reply("Solicitud actualizada");

}

}

/**************** IA ****************/

const ai = await askDeepSeek(userId,empresaId,text);

return ctx.reply(ai);

});

/******************************************************************
 WEBHOOK
******************************************************************/

const WEBHOOK_PATH="/telegram";

app.post(WEBHOOK_PATH,bot.webhookCallback(WEBHOOK_PATH));

async function start(){

await initDB();

app.listen(PORT);

}

start();