const { Pool } = require('pg');
require('dotenv').config();

// Set up the PostgreSQL connection using the environment variable
const pool = new Pool({
  host: process.env.SUPABASE_DATABASE_HOST,
  database: process.env.SUPABASE_DATABASE,
  user: process.env.SUPABASE_USER,
  password: process.env.SUPABASE_PASSWORD,
  port: 5432,
  ssl: {
    rejectUnauthorized: false, // Allow self-signed certificates
  },
});

// Export the pool for use in other files
module.exports = {
  query: (text, params) => pool.query(text, params),
};