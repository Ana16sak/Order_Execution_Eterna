// src/lib/db/pool.ts
import { Pool } from "pg";

const {
  PG_HOST,
  PG_PORT,
  PG_USER,
  PG_PASSWORD,
  PG_DATABASE
} = process.env;

// Build DSN
const connectionString =
  process.env.POSTGRES_URL ||
  `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`;

console.log("DB CONNECT:", connectionString);

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
