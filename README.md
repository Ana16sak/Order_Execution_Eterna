Below is a **complete, production-ready `README.md`** tailored to your project architecture and matching the spec in *Backend Task 2 – Order Execution Engine.pdf*.
I included the required spec citation:


You can copy-paste this directly into your GitHub repo.

---

# 🚀 Order Execution Engine

A high-performance backend system for processing crypto market orders with DEX routing, WebSocket lifecycle streaming, and concurrent processing using BullMQ.

> **Spec Reference:**
> Full problem statement: *Backend Task 2 – Order Execution Engine.pdf*
>

---

# 📑 Table of Contents

* [Overview](#overview)
* [Architecture](#architecture)
* [Why Market Orders?](#why-market-orders)
* [How Limit & Sniper Orders Could Be Added](#how-limit--sniper-orders-could-be-added)
* [Tech Stack](#tech-stack)
* [System Design](#system-design)

  * [Execution Flow](#execution-flow)
  * [DEX Routing Logic](#dex-routing-logic)
  * [Retry Logic](#retry-logic)
  * [WebSocket Lifecycle Events](#websocket-lifecycle-events)
* [Project Structure](#project-structure)
* [Database Schema](#database-schema)
* [Running Locally](#running-locally)
* [Environment Variables](#environment-variables)
* [API Usage](#api-usage)
* [WebSocket Usage](#websocket-usage)
* [Testing](#testing)
* [Deployment Notes](#deployment-notes)
* [License](#license)

---

# 🧠 Overview

This backend implements a **market order execution engine** with:

* **HTTP → WebSocket pattern** (POST returns orderId, then upgrades to WS)
* **BullMQ + Redis queue** for concurrent processing (up to 10 workers)
* **Mock DEX router** with deterministic simulated pricing
* **Event-driven lifecycle streaming** for every order
* **PostgreSQL order persistence**
* **Redis active order state**
* **Graceful shutdown & structured logging**

This implementation is architected so the mock router can later be replaced with **real Raydium / Meteora devnet execution** without changing the worker’s core logic.

---

# 🏗 Architecture

```
┌────────────┐     POST /api/orders       ┌─────────────┐
│   Client   │ ─────────────────────────▶ │   Fastify   │
│            │ ◀────── orderId ────────── │   API       │
└─────┬──────┘                            └────┬────────┘
      │ WebSocket /ws                       enqueue job
      ▼                                      │
┌────────────┐                           ┌────▼─────────┐
│ WebSocket   │◀──── stream events ───── │   BullMQ     │
│  Gateway    │                           │   Queue      │
└─────┬──────┘                           └────┬─────────┘
      │ worker consumes                      │
      ▼                                      ▼
┌───────────────┐                     ┌───────────────┐
│ Worker (10x)   │───── DEX router ─▶ │ Mock DEX Router│
│ Retry + events │                     └───────────────┘
└──────┬────────┘
       │ writes lifecycle
       ▼
┌──────────────┐
│ Postgres DB  │
└──────────────┘
```

---

# 🎯 Why Market Orders?

I chose **market orders** because:

1. They match the spec’s requirement for immediate execution & DEX price selection.
2. They are the simplest baseline to design a **generic routing + lifecycle engine** on top of.

---

# 🔧 How Limit & Sniper Orders Could Be Added

### 🔹 Limit Orders

* Store `targetPrice` in the DB.
* A **price-watcher worker** listens to price feeds.
* When `marketPrice <= targetPrice`, enqueue the execution job.
* Reuse the exact same DEX routing + lifecycle pipeline.

### 🔹 Sniper Orders

* Watch for **token mint creation / pool creation** events.
* Trigger execution once liquidity pool becomes active.
* Plug into the same worker pipeline with minimal changes.

---

# 🛠 Tech Stack

| Component  | Technology                               |
| ---------- | ---------------------------------------- |
| Runtime    | Node.js + TypeScript                     |
| API        | Fastify                                  |
| Queue      | BullMQ + Redis                           |
| Database   | PostgreSQL                               |
| WebSockets | Fastify WebSocket plugin                 |
| Logging    | Pino structured JSON                     |
| Testing    | Jest + supertest + Docker testcontainers |
| Deployment | Docker Compose                           |

---

# ⚙ System Design

## Execution Flow

1. Client sends **POST `/api/orders`**
2. API validates order → creates DB row (`queued`)
3. API enqueues BullMQ job
4. Client upgrades connection → `ws://host/ws?orderId=...`
5. Worker processes the job:

   * `pending`
   * `routing`
   * `building`
   * `submitted`
   * `confirmed` or `failed`
6. Events are streamed via WebSocket
7. Final state saved to Postgres

---

## DEX Routing Logic

The mock router simulates Raydium & Meteora pricing:

```
price_raydium = base * (0.98 + rand * 0.04)
price_meteora = base * (0.97 + rand * 0.05)
```

Worker chooses the best venue:

```
best = price_raydium > price_meteora ? "raydium" : "meteora"
```

Each step emits lifecycle events.

---

## Retry Logic

* Max retries: **3** (configurable)
* Backoff: **exponential** (1s → 2s → 4s)
* Failures:

  * quote fetch error
  * tx simulation failure
  * random mock execution failure

On final failure → `status = failed`, error stored.

---

## WebSocket Lifecycle Events

| Event       | Meaning                    |
| ----------- | -------------------------- |
| `pending`   | Order queued               |
| `routing`   | Fetching quotes            |
| `building`  | Constructing transaction   |
| `submitted` | Swap submitted             |
| `confirmed` | Executed (txHash included) |
| `failed`    | Terminal failure           |

---

# 📂 Project Structure

```
src/
  api/
    orders.ts
  lib/
    db.ts
    redis.ts
    queue.ts
    logger.ts
  workers/
    worker.ts
    dexRouterMock.ts
    events.ts
  ws/
    websocketGateway.ts
migrations/
docker/
__tests__/
.env.example
docker-compose.yml
README.md
```

---

# 🗄 Database Schema

## `orders`

| column         | type      |
| -------------- | --------- |
| id             | uuid (PK) |
| user_id        | uuid      |
| type           | text      |
| token_in       | text      |
| token_out      | text      |
| amount_in      | numeric   |
| amount_out     | numeric   |
| min_amount_out | numeric   |
| chosen_dex     | text      |
| route_meta     | jsonb     |
| retries        | int       |
| max_retries    | int       |
| status         | text      |

## `order_events`

| column     | type      |
| ---------- | --------- |
| id         | uuid      |
| order_id   | uuid      |
| event      | text      |
| meta       | jsonb     |
| created_at | timestamp |

---

# ▶ Running Locally

### 1. Clone

```
git clone https://github.com/<your-username>/<your-repo>
cd <your-repo>
```

### 2. Copy env file

```
cp .env.example .env
```

### 3. Build & start

```
docker-compose up --build
```

Services start at:

* API → [http://localhost:3000](http://localhost:3000)
* Redis → localhost:6379
* Postgres → localhost:5432

---

# 🔧 Environment Variables

```
PORT=3000

POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=orders

REDIS_HOST=redis
REDIS_PORT=6379

WORKER_CONCURRENCY=10
MAX_RETRIES=3
```

---

# 📡 API Usage

## Submit Market Order

### `POST /api/orders`

```json
{
  "userId": "00000000-0000-0000-0000-000000000006",
  "type": "market",
  "tokenIn": "SOL",
  "tokenOut": "USDC",
  "amountIn": "1",
  "slippageTolerance": "0.01"
}
```

### Response

```json
{
  "orderId": "c9025e4e-57c1-4df8-92a3-60234a1e9cc3"
}
```

### Example Received Messages:

```
{ "event": "pending" }
{ "event": "routing" }
{ "event": "building" }
{ "event": "submitted", "txHash": "0x123..." }
{ "event": "confirmed", "executedPrice": 14.92 }
```

---

# 🧪 Testing

### Run tests

```
npm test
```

Includes:

* Mock router tests
* Worker retry logic tests
* Queue concurrency tests
* WebSocket lifecycle integration test
* Redis + Postgres integration tests
* DEX routing logic correctness tests

---

# 🌐 Deployment Notes

For free-tier hosts (Railway, Fly.io, Render):

* REST API + WebSocket must be on the same container
* Use multi-stage Docker build to keep image < 150MB
* Redis & Postgres likely need managed services
* Ensure worker runs as a **separate container**

---

