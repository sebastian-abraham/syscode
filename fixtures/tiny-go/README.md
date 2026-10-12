# shopkit-go

A small Go storefront service: an HTTP API over orders, payments and notifications, backed
by Postgres and Redis.

`cmd/api` is the entry point. `internal/orders` owns the order lifecycle, `internal/payments`
talks to Stripe, `internal/notifications` queues mail through Redis, and `internal/store` is
the shared Postgres pool.

Kept deliberately tiny: it exists so SysCode can be exercised against a stack it has no
analyzer for.
