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
 ESTADO
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
 🔥 NUEVO: DETECTAR EMPRESA
******************************************************************/

async function esEmpresa(userId){
  const r = await db.query(
    "SELECT id FROM empresas WHERE telegram_id=$1",
    [userId]
  );
  return r.rows[0] || null;
}

/******************************************************************
 🔥 MENÚ DINÁMICO
******************************************************************/

async function mostrarMenu(ctx){

const userId = ctx.from.id;
const empresa = await esEmpresa(userId);

// 🏢 PANEL EMPRESA
if(empresa){
return ctx.reply(
"🏢 Panel empresa",
{
reply_markup:{
inline_keyboard:[
[{ text:"📥 Ver solicitudes", callback_data:"empresa_ver_solicitudes" }],
[{ text:"📊 Reportes", callback_data:"empresa_reportes" }]
]
}
}
);
}

// 👤 CLIENTE
return ctx.reply(
"📍 Menú principal",
{
reply_markup:{
inline_keyboard:[
[{ text:"➕ Nueva solicitud", callback_data:"nueva_solicitud" }],
[{ text:"📋 Ver solicitudes", callback_data:"ver_solicitudes" }],
[{ text:"🏢 Elegir empresa", callback_data:"elegir_empresa" }]
]
}
}
);

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

const estadoActual = await getEstado(userId);

await setEstado(userId,"menu",{
...estadoActual?.datos,
empresa_id:empresaId,
iniciado:true
});

await ctx.answerCbQuery();

await ctx.reply("🏢 Empresa seleccionada");

return mostrarMenu(ctx);

});

/******************************************************************
 🔥 VER SOLICITUDES EMPRESA
******************************************************************/

async function verSolicitudesEmpresa(ctx, empresaId){

const r = await db.query(
"SELECT id,servicio,fecha,user_id FROM solicitudes WHERE empresa_id=$1 ORDER BY id DESC LIMIT 10",
[empresaId]
);

if(r.rows.length===0){
return ctx.reply("📭 No tienes solicitudes aún");
}

let texto = "📥 *Solicitudes recibidas:*\n\n";

r.rows.forEach((s,i)=>{
texto += `${i+1}. 🛠 ${s.servicio}\n📅 ${s.fecha}\n👤 Cliente: ${s.user_id}\n\n`;
});

const botones = r.rows.map(s=>[
{ text:`✅ Aceptar #${s.id}`, callback_data:`aceptar_${s.id}` },
{ text:`❌ Rechazar #${s.id}`, callback_data:`rechazar_${s.id}` }
]);

return ctx.reply(texto,{
parse_mode:"Markdown",
reply_markup:{inline_keyboard:botones}
});

}

bot.action("empresa_ver_solicitudes", async ctx=>{
await ctx.answerCbQuery();
const empresa = await esEmpresa(ctx.from.id);
if(!empresa) return ctx.reply("No eres empresa");
return verSolicitudesEmpresa(ctx, empresa.id);
});

/******************************************************************
 START + INICIO
******************************************************************/

bot.start(async ctx=>{

const userId = ctx.from.id;

await setEstado(userId,"inicio",{iniciado:false});

return ctx.reply(
`👋 Hola ${ctx.from.first_name}

Bienvenido a tu asistente`,
{
reply_markup:{
inline_keyboard:[[
{ text:"🚀 Iniciar", callback_data:"iniciar_bot" }
]]
}
}
);

});

bot.action("iniciar_bot", async ctx=>{

await setEstado(ctx.from.id,"menu",{iniciado:true});

await ctx.answerCbQuery();

return mostrarMenu(ctx);

});

/******************************************************************
 MENÚ ACCIONES
******************************************************************/

bot.action("elegir_empresa", async ctx=>{
await ctx.answerCbQuery();
return mostrarEmpresas(ctx);
});

bot.action("ver_solicitudes", async ctx=>{
await ctx.answerCbQuery();
ctx.message = { text: "ver solicitudes" };
return bot.handleUpdate(ctx.update);
});

bot.action("nueva_solicitud", async ctx=>{

await ctx.answerCbQuery();

const estado = await getEstado(ctx.from.id);

if(!estado?.datos?.empresa_id){
return ctx.reply("⚠️ Primero selecciona una empresa");
}

await setEstado(ctx.from.id,"servicio",{...estado.datos,iniciado:true});

return ctx.reply("¿Qué servicio necesitas?");
});

bot.on("text", async ctx=>{

  const text = ctx.message.text.trim();
  const userId = ctx.from.id;
  
  console.log("👤",userId,"💬",text);
  
  /******** 🔒 BLOQUEO ********/
  
  const estadoGlobal = await getEstado(userId);
  
  if(!estadoGlobal || !estadoGlobal.datos?.iniciado){
  return ctx.reply(
  "⚠️ Debes iniciar primero",
  {
  reply_markup:{
  inline_keyboard:[[
  { text:"🚀 Iniciar", callback_data:"iniciar_bot" }
  ]]
  }
  }
  );
  }
  
  /**************** COMANDOS ****************/
  
  if(text.startsWith("/crear_empresa")){
  const partes = text.split(" ");
  await db.query(
  "INSERT INTO empresas (nombre,codigo) VALUES ($1,$2)",
  [partes[1],partes[2]]
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
  
  ctx.reply("Empresa vinculada");
  
  return mostrarMenu(ctx);
  }
  
  /**************** REPORTE ****************/
  
  if(text.toLowerCase()==="reporte"){
  
  const empresa = await esEmpresa(userId);
  
  if(!empresa){
  return ctx.reply("Solo empresas pueden usar reportes");
  }
  
  const r = await db.query(
  "SELECT id,servicio,fecha,user_id,created_at FROM solicitudes WHERE empresa_id=$1 ORDER BY id DESC",
  [empresa.id]
  );
  
  if(r.rows.length===0){
  return ctx.reply("No hay solicitudes");
  }
  
  const csv = stringify(r.rows,{
  header:true,
  columns:["id","servicio","fecha","user_id","created_at"]
  });
  
  return ctx.replyWithDocument({
  source:Buffer.from(csv),
  filename:"reporte.csv"
  });
  }
  
  /**************** EMPRESA / CLIENTE ****************/
  
  const estado = await getEstado(userId);
  const empresaId = estado?.datos?.empresa_id;
  
  if(!empresaId && !(await esEmpresa(userId))){
  return ctx.reply(
  "⚠️ Selecciona una empresa",
  {
  reply_markup:{
  inline_keyboard:[[
  { text:"🏢 Elegir empresa", callback_data:"elegir_empresa" }
  ]]
  }
  }
  );
  }
  
  /**************** INTENT ****************/
  
  const lower = text.toLowerCase();
  
  let intent = "fallback";
  
  if(lower.includes("ver")) intent="ConsultarSolicitudes";
  if(lower.includes("solicitudes")) intent="ConsultarSolicitudes";
  if(lower.includes("cancelar")) intent="CancelarSolicitud";
  if(lower.includes("modificar")) intent="ModificarSolicitud";
  if(lower.includes("nuevo") || lower.includes("solicitar"))
  intent="Solicitud";
  
  /**************** VER SOLICITUDES CLIENTE ****************/
  
  if(intent==="ConsultarSolicitudes"){
  
  const r = await db.query(
  "SELECT id,servicio,fecha FROM solicitudes WHERE user_id=$1 AND empresa_id=$2 ORDER BY id DESC LIMIT 10",
  [userId,empresaId]
  );
  
  if(r.rows.length===0){
  return ctx.reply("📭 No tienes solicitudes");
  }
  
  let texto="📋 *Tus solicitudes:*\n\n";
  
  r.rows.forEach((s,i)=>{
  texto+=`${i+1}. 🛠 ${s.servicio}\n📅 ${s.fecha}\n\n`;
  });
  
  const botones = r.rows.map(s=>[
  { text:`✏️ ${s.id}`, callback_data:`modificar_${s.id}` },
  { text:`❌ ${s.id}`, callback_data:`cancelar_${s.id}` }
  ]);
  
  return ctx.reply(texto,{
  parse_mode:"Markdown",
  reply_markup:{inline_keyboard:botones}
  });
  }
  
  /**************** NUEVA SOLICITUD ****************/
  
  if(intent==="Solicitud"){
  await setEstado(userId,"servicio",{empresa_id:empresaId,iniciado:true});
  return ctx.reply("¿Qué servicio necesitas?");
  }
  
  /**************** ESTADOS ****************/
  
  if(estado){
  
  const datos = estado.datos || {};
  
  if(estado.paso==="servicio"){
  datos.servicio=text;
  await setEstado(userId,"fecha",{...datos,iniciado:true});
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
  `📩 Nueva solicitud #${solicitudId}
  
  👤 Cliente: ${ctx.from.first_name}
  🛠 ${datos.servicio}
  📅 ${text}`,
  {
  reply_markup:{
  inline_keyboard:[[
  { text:"✅ Aceptar", callback_data:`aceptar_${solicitudId}` },
  { text:"❌ Rechazar", callback_data:`rechazar_${solicitudId}` }
  ]]
  }
  }
  );
  
  }
  
  await clearEstado(userId);
  
  return ctx.reply("✅ Solicitud registrada");
  
  }
  
  }
  
  });

  /******************************************************************
 WEBHOOK
******************************************************************/

const WEBHOOK_PATH="/telegram";

app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

async function start(){
  await initDB();

  app.listen(PORT, () => {
    console.log("Servidor corriendo en puerto", PORT);
  });
}

start();