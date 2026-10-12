/**
 * Classifying third-party packages: which ones represent something *outside* the
 * codebase (and so can become nodes), which are frameworks, which are runtime.
 * Lives on its own so the mapper does not have to import the analyzer.
 */

/** Packages that represent something *outside* the codebase — they can become nodes. */
export const SERVICE_PKGS: Record<string, string> = {
  pg: 'Postgres', postgres: 'Postgres', psycopg2: 'Postgres', 'psycopg2-binary': 'Postgres',
  mysql: 'MySQL', mysql2: 'MySQL', sqlite3: 'SQLite', 'better-sqlite3': 'SQLite', 'node:sqlite': 'SQLite',
  mongodb: 'MongoDB', mongoose: 'MongoDB', redis: 'Redis', ioredis: 'Redis', celery: 'Celery',
  stripe: 'Stripe', '@stripe/stripe-js': 'Stripe', twilio: 'Twilio', '@sendgrid/mail': 'SendGrid',
  nodemailer: 'SMTP', '@supabase/supabase-js': 'Supabase', firebase: 'Firebase', 'firebase-admin': 'Firebase',
  '@elastic/elasticsearch': 'Elasticsearch', kafkajs: 'Kafka', amqplib: 'RabbitMQ', boto3: 'AWS',
  'aws-sdk': 'AWS', '@aws-sdk/client-s3': 'S3', openai: 'OpenAI', '@anthropic-ai/sdk': 'Anthropic',
  prisma: 'Prisma', '@prisma/client': 'Postgres', 'drizzle-orm': 'SQL', typeorm: 'SQL', sequelize: 'SQL',
  requests: 'HTTP APIs', httpx: 'HTTP APIs',
  // Other ecosystems, matched as whole path segments (Go, Rust, Java, Ruby, PHP, C#). A Go
  // project's `github.com/redis/go-redis/v9` is Redis, and the map should be able to say so.
  pq: 'Postgres', pgx: 'Postgres', 'go-redis': 'Redis', 'redis-rs': 'Redis', r2d2: 'Postgres',
  'go-sql-driver': 'MySQL', 'mysql-connector': 'MySQL', 'mongo-driver': 'MongoDB', 'mongo-rust-driver': 'MongoDB',
  rusqlite: 'SQLite', sqlx: 'SQL', jdbc: 'SQL', hibernate: 'SQL', jpa: 'SQL', diesel: 'SQL',
  'stripe-go': 'Stripe', 'stripe-ruby': 'Stripe', 'stripe-php': 'Stripe', 'sendgrid-go': 'SendGrid',
  'aws-sdk-go': 'AWS', 'aws-sdk-java': 'AWS', 'aws-sdk-rust': 'AWS', 'google-cloud-storage': 'GCS',
  'aws-sdk-net': 'AWS', rdkafka: 'Kafka', 'kafka-go': 'Kafka', lapin: 'RabbitMQ', 'amqp-client': 'RabbitMQ',
  sidekiq: 'Redis', resque: 'Redis', 'laravel-redis': 'Redis', activejob: 'Jobs', 'action-cable': 'WebSockets',
};

export const FRAMEWORK_PKGS = new Set([
  'react', 'react-dom', 'next', 'vue', 'svelte', 'solid-js', 'preact', 'angular', '@angular/core',
  'express', 'fastify', 'koa', 'hapi', '@nestjs/core', '@nestjs/common', 'hono', 'polka',
  'flask', 'django', 'fastapi', 'uvicorn', 'gunicorn', 'starlette', 'tornado', 'aiohttp',
  'vite', 'webpack', 'rollup', 'esbuild', 'parcel', 'tailwindcss', 'styled-components',
  'jest', 'vitest', 'mocha', 'ava', 'pytest', 'unittest', 'playwright', '@playwright/test', 'cypress',
  'react-router-dom', 'react-router', '@tanstack/react-query', 'redux', 'zustand', 'mobx',
  'zod', 'yup', 'joi', 'pydantic', 'sqlalchemy', 'alembic', 'django-rest-framework', 'rest_framework',
]);

const RUNTIME_PKGS = new Set([
  'path', 'fs', 'http', 'crypto', 'os', 'util', 'stream', 'events', 'url', 'zlib', 'child_process',
  'readline', 'assert', 'buffer', 'querystring', 'net', 'tls', 'dns', 'worker_threads', 'timers',
  'process', 'sys', 'json', 're', 'datetime', 'typing', 'collections', 'functools', 'itertools',
  'math', 'random', 'time', 'io', 'csv', 'logging', 'dataclasses', 'abc', 'enum', 'uuid', 'hashlib',
  'base64', 'asyncio', 'threading', 'subprocess', 'unittest', 'pathlib', 'contextlib', 'warnings',
  'traceback', 'sqlite', 'sqlite3',
]);

export type ExternalKind = 'service' | 'framework' | 'runtime' | 'unknown';

export function classifyExternal(name: string): ExternalKind {
  const bare = name.replace(/^@[^/]+\//, '');
  if (SERVICE_PKGS[name] || SERVICE_PKGS[bare]) return 'service';
  if (FRAMEWORK_PKGS.has(name) || FRAMEWORK_PKGS.has(bare)) return 'framework';
  if (name.startsWith('node:') || RUNTIME_PKGS.has(name) || RUNTIME_PKGS.has(bare)) return 'runtime';
  return 'unknown';
}

/** The human name of an external service, if this package is one. */
export function serviceLabel(pkg: string): string | undefined {
  const bare = pkg.replace(/^@[^/]+\//, '');
  return SERVICE_PKGS[pkg] ?? SERVICE_PKGS[bare];
}

/**
 * Classify a package *path* from any ecosystem — `github.com/redis/go-redis/v9`,
 * `com.stripe.Stripe`, `redis`. A service key counts only when it is a whole path segment
 * (or the segment minus an ecosystem prefix), so `pg` cannot match `pgrep`. Returns the
 * matched key as well, because that is what `serviceLabel` can turn into a name.
 */
export function classifyPackagePath(raw: string): { kind: ExternalKind; key?: string; label?: string } {
  const segments = raw.split(/[/\\:]+/).filter(Boolean).map((s) => s.toLowerCase());
  while (segments.length && /^v?\d+(\.\d+)*$/.test(segments[segments.length - 1])) segments.pop();
  for (const seg of segments) {
    const stripped = seg.replace(/^(go|node|php|python|py|java|rust|rs|spring-boot|dotnet)-/, '');
    const key = SERVICE_PKGS[seg] ? seg : SERVICE_PKGS[stripped] ? stripped : undefined;
    if (key) return { kind: 'service', key, label: SERVICE_PKGS[key] };
  }
  const last = segments[segments.length - 1] ?? raw;
  return { kind: classifyExternal(last) };
}
