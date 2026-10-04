# shopkit

Storefront backend for a small direct-to-consumer shop. Handles the catalog,
cart, checkout and order fulfillment for a single storefront, plus a thin admin
API for the ops team.

## Layout

    src/server     Express app: routes, middleware, HTTP helpers
    src/auth       Sessions, JWTs, password hashing, role checks
    src/orders     Cart validation, stock reservation, order lifecycle
    src/payments   Stripe wrapper: charges, refunds, webhooks
    src/db         Postgres pool, migrations, models, query builder
    src/notifications  Redis-backed queue + email worker
    src/analytics  Read-only reporting queries
    web/src        React storefront that talks to the API

## Running

Requires Postgres and Redis (see `.env.example`).

    npm install
    npm run build
    npm run start        # API on :4000
    npm run worker       # background email worker (separate process)
