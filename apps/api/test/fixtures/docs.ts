import type { FixtureRepo } from './repos.js';

/**
 * A small orders service whose files line up with `fixtureGraph()`, plus the build, CI and
 * contribution files the documentation generators look for.
 */
export const ORDERS_SERVICE: FixtureRepo['files'] = {
  'README.md': '# Orders\n\nAn orders service.\n\n## Getting started\n\nRun `npm run dev` after `npm ci`.\n',
  'package.json': JSON.stringify(
    {
      name: 'orders',
      version: '2.0.0',
      scripts: { dev: 'tsx watch src/index.ts', build: 'tsc', start: 'node dist/index.js', test: 'vitest', lint: 'eslint .' },
      dependencies: { express: '^5.0.0', mongoose: '^9.0.0', jsonwebtoken: '^9.0.0' },
      engines: { node: '>=22' },
    },
    null,
    2,
  ),
  'package-lock.json': '{"lockfileVersion":3}',
  '.env.example': '# Port to listen on\nPORT=4000\n# MongoDB connection string\nMONGODB_URI=\n# Signs session tokens\nJWT_SECRET=\n',
  'src/index.ts': [
    "import express from 'express';",
    "import { router } from './routes/orders.js';",
    "import { requireAuth } from './middleware/auth.js';",
    'const app = express();',
    'app.use(express.json());',
    "app.use('/api', requireAuth, router);",
    'app.listen(Number(process.env.PORT ?? 4000));',
  ].join('\n'),
  'src/routes/orders.ts': [
    "import { Router } from 'express';",
    "import { Order } from '../models/order.js';",
    'export const router = Router();',
    'export async function listOrders(_req, res) { res.json(await Order.find()); }',
    "router.get('/orders', listOrders);",
    "router.post('/orders', async (req, res) => res.status(201).json(await Order.create(req.body)));",
  ].join('\n'),
  'src/models/order.ts': [
    "import { Schema, model } from 'mongoose';",
    '',
    'const orderSchema = new Schema({ item: { type: String, required: true }, quantity: { type: Number, default: 1 } });',
    "export const Order = model('Order', orderSchema);",
  ].join('\n'),
  'src/middleware/auth.ts': [
    "import jwt from 'jsonwebtoken';",
    'export function requireAuth(req, res, next) {',
    "  const token = req.headers.authorization?.replace('Bearer ', '');",
    '  jwt.verify(token, process.env.JWT_SECRET);',
    '  next();',
    '}',
  ].join('\n'),
  Dockerfile: 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nEXPOSE 4000\nCMD ["node", "dist/index.js"]\n',
  '.github/workflows/ci.yml': 'name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n',
  'commitlint.config.js': "export default { extends: ['@commitlint/config-conventional'] };\n",
  LICENSE: 'MIT License\n',
}; // prettier-ignore
