import express from "express";

const app = express();

app.get("/ping", (req, res) => {
  console.log("📡 Ping recibido");
  res.send("pong");
});

app.listen(3001, () => {
  console.log("🚀 Express puro escuchando en http://localhost:3001");
});
