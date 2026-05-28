import path from 'path';
import { defineConfig } from '@prisma/config';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  schema: path.join('prisma', 'schema'),
  datasource: {
    url: process.env.DATABASE_URL,
  },
});