import mysql from "mysql2/promise";

export const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "asistente_pyme",
  waitForConnections: true,
  connectionLimit: 10,
});