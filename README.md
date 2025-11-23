# Order Execution Engine — Backend Task 2

This repository scaffolds a backend order execution engine (Node + TypeScript) that accepts orders via HTTP and streams lifecycle events over WebSockets. It uses a queue (BullMQ/Redis), PostgreSQL for history, and Redis for ephemeral active-order state.

## Project status

This repo contains initial scaffolding and developer tooling (TypeScript, ESLint, Prettier, Husky). Next steps: DB migrations, API implementation, BullMQ worker, mock DEX router and tests.

## Design & spec

The full assignment/spec is stored with the project files: /mnt/data/Backend Task 2_ Order Execution Engine.pdf. See the original problem statement and deliverables for details.

## Why start here

Setting up a consistent project structure and linting/formatting hooks ensures later components (API, worker, migrations) plug into a stable baseline and are easier to test and maintain.

## Order type chosen (for the implementation)
**Market order (initial implementation)** — immediate execution at current price.  

## Quick start (dev)

```bash
cp .env.example .env
npm install
npm run prepare   # installs husky hooks
npm run dev

