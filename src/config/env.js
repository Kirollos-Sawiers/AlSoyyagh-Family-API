import 'dotenv/config';

const required = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing environment variable: ${name}`);
    process.exit(1);
  }
  return v;
};

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT) || 4000,
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
};

if (env.jwtSecret.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters long.');
  process.exit(1);
}