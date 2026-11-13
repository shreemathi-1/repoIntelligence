import type { AuthApproach, DbEngine, Infrastructure } from '@repointelligence/shared';

/** What reveals that a repository talks to a service: environment variable names and client packages. */
export interface ServiceRule {
  id: string;
  label: string;
  kind: 'database' | 'infrastructure' | 'saas';
  env?: RegExp;
  packages?: string[];
  /** Image names in a compose file. */
  images?: RegExp;
  engine?: DbEngine;
  /** The profile's infrastructure entry that covers it. */
  infrastructure?: Infrastructure;
}

export const SERVICES: ServiceRule[] = [
  { id: 'postgresql', label: 'PostgreSQL', kind: 'database', engine: 'postgresql', env: /^(POSTGRES|PG(HOST|USER|DATABASE|PASSWORD)$)/, packages: ['pg', 'postgres', 'psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'org.postgresql:postgresql', 'github.com/lib/pq', 'github.com/jackc/pgx'], images: /^postgres(:|$)/ },
  { id: 'mysql', label: 'MySQL', kind: 'database', engine: 'mysql', env: /^MYSQL_/, packages: ['mysql', 'mysql2', 'pymysql', 'mysqlclient', 'mysql:mysql-connector-java', 'com.mysql:mysql-connector-j', 'github.com/go-sql-driver/mysql'], images: /^(mysql|mariadb)(:|$)/ },
  { id: 'mongodb', label: 'MongoDB', kind: 'database', engine: 'mongodb', env: /^MONGO(DB)?_/, packages: ['mongodb', 'mongoose', 'pymongo', 'motor', 'mongoengine', 'go.mongodb.org/mongo-driver'], images: /^mongo(:|$)/ },
  { id: 'sqlite', label: 'SQLite', kind: 'database', engine: 'sqlite', env: /^SQLITE_/, packages: ['sqlite3', 'better-sqlite3', 'aiosqlite', 'github.com/mattn/go-sqlite3'] },
  { id: 'mssql', label: 'SQL Server', kind: 'database', engine: 'mssql', env: /^MSSQL_/, packages: ['mssql', 'tedious', 'pyodbc', 'pymssql'], images: /mssql/ },
  { id: 'redis', label: 'Redis', kind: 'infrastructure', infrastructure: 'redis', env: /^REDIS_/, packages: ['redis', 'ioredis', 'bullmq', 'bull', 'celery[redis]', 'github.com/redis/go-redis'], images: /^redis(:|$)/ },
  { id: 'queue', label: 'Message queue', kind: 'infrastructure', infrastructure: 'queue', env: /^(RABBITMQ|AMQP|KAFKA|SQS)_/, packages: ['amqplib', 'kafkajs', 'pika', 'kafka-python', 'confluent-kafka', '@aws-sdk/client-sqs'], images: /^(rabbitmq|.*kafka)(:|$)/ },
  { id: 'object-storage', label: 'Object storage', kind: 'infrastructure', infrastructure: 'object-storage', env: /^(S3|MINIO|GCS)_|_BUCKET$/, packages: ['@aws-sdk/client-s3', 'minio', '@google-cloud/storage', 'google-cloud-storage', '@azure/storage-blob'], images: /minio/ },
  { id: 'smtp', label: 'Outgoing email (SMTP)', kind: 'infrastructure', infrastructure: 'smtp', env: /^(SMTP|MAIL)_/, packages: ['nodemailer'] },
  { id: 'search', label: 'Search engine', kind: 'infrastructure', infrastructure: 'search', env: /^(ELASTIC(SEARCH)?|OPENSEARCH|MEILI(SEARCH)?|ALGOLIA)_/, packages: ['@elastic/elasticsearch', 'elasticsearch', 'meilisearch', 'algoliasearch', 'opensearch-py'], images: /(elasticsearch|opensearch|meilisearch)/ },
  { id: 'stripe', label: 'Stripe', kind: 'saas', env: /^STRIPE_/, packages: ['stripe'] },
  { id: 'aws', label: 'AWS', kind: 'saas', env: /^AWS_/, packages: ['aws-sdk', 'boto3'] },
  { id: 'gcp', label: 'Google Cloud', kind: 'saas', env: /^(GOOGLE_APPLICATION_CREDENTIALS|GCP_|GCLOUD_)/, packages: ['google-cloud'] },
  { id: 'firebase', label: 'Firebase', kind: 'saas', env: /^FIREBASE_/, packages: ['firebase', 'firebase-admin'] },
  { id: 'sendgrid', label: 'SendGrid', kind: 'saas', env: /^SENDGRID_/, packages: ['@sendgrid/mail', 'sendgrid'] },
  { id: 'twilio', label: 'Twilio', kind: 'saas', env: /^TWILIO_/, packages: ['twilio'] },
  { id: 'openai', label: 'OpenAI API', kind: 'saas', env: /^OPENAI_/, packages: ['openai'] },
  { id: 'sentry', label: 'Sentry', kind: 'saas', env: /^SENTRY_/, packages: ['@sentry/node', '@sentry/browser', 'sentry-sdk'] },
  { id: 'github', label: 'GitHub API', kind: 'saas', env: /^GITHUB_(TOKEN|CLIENT|APP)/, packages: ['octokit', '@octokit/rest', 'pygithub'] },
  { id: 'slack', label: 'Slack', kind: 'saas', env: /^SLACK_/, packages: ['@slack/web-api', '@slack/bolt', 'slack-sdk'] },
]; // prettier-ignore

/** A generic connection string names its engine only in the value, which is not stored. */
export const GENERIC_DATABASE_ENV = /^(DATABASE_URL|DB_(HOST|URL|NAME|USER|PASSWORD|PORT))$/;

/** ORMs and the engines they can talk to. A single-engine ORM ties the code to that engine. */
export const ORMS: Record<string, { label: string; engines: DbEngine[]; packages: string[] }> = {
  mongoose: { label: 'Mongoose', engines: ['mongodb'], packages: ['mongoose'] },
  prisma: { label: 'Prisma', engines: ['postgresql', 'mysql', 'sqlite', 'mongodb', 'mssql'], packages: ['prisma', '@prisma/client'] },
  typeorm: { label: 'TypeORM', engines: ['postgresql', 'mysql', 'sqlite', 'mongodb', 'mssql'], packages: ['typeorm'] },
  sequelize: { label: 'Sequelize', engines: ['postgresql', 'mysql', 'sqlite', 'mssql'], packages: ['sequelize'] },
  drizzle: { label: 'Drizzle', engines: ['postgresql', 'mysql', 'sqlite'], packages: ['drizzle-orm'] },
  knex: { label: 'Knex', engines: ['postgresql', 'mysql', 'sqlite', 'mssql'], packages: ['knex'] },
  sqlalchemy: { label: 'SQLAlchemy', engines: ['postgresql', 'mysql', 'sqlite', 'mssql'], packages: ['sqlalchemy', 'flask-sqlalchemy', 'sqlmodel'] },
  django: { label: 'Django ORM', engines: ['postgresql', 'mysql', 'sqlite'], packages: ['django'] },
  hibernate: { label: 'Hibernate / JPA', engines: ['postgresql', 'mysql', 'sqlite', 'mssql'], packages: ['org.hibernate:hibernate-core', 'org.hibernate.orm:hibernate-core', 'org.springframework.boot:spring-boot-starter-data-jpa'] },
  gorm: { label: 'GORM', engines: ['postgresql', 'mysql', 'sqlite', 'mssql'], packages: ['gorm.io/gorm'] },
}; // prettier-ignore

export const AUTH_PACKAGES: { approach: AuthApproach; label: string; packages: string[] }[] = [
  { approach: 'jwt', label: 'JSON Web Tokens', packages: ['jsonwebtoken', 'jose', 'express-jwt', 'pyjwt', 'python-jose', 'djangorestframework-simplejwt', 'flask-jwt-extended', 'io.jsonwebtoken:jjwt', 'github.com/golang-jwt/jwt'] },
  { approach: 'session', label: 'Server sessions', packages: ['express-session', 'cookie-session', 'passport-local', 'flask-login', 'iron-session'] },
  { approach: 'oauth', label: 'OAuth / OpenID Connect', packages: ['next-auth', '@auth/core', 'passport-oauth2', 'passport-google-oauth20', 'passport-github2', 'openid-client', 'authlib', 'django-allauth', 'golang.org/x/oauth2', 'org.springframework.boot:spring-boot-starter-oauth2-client'] },
  { approach: 'saml', label: 'SAML', packages: ['passport-saml', '@node-saml/passport-saml', 'python3-saml', 'samlify'] },
  { approach: 'hosted', label: 'Hosted identity provider', packages: ['auth0', '@auth0/nextjs-auth0', 'express-openid-connect', '@clerk/clerk-sdk-node', '@clerk/nextjs', 'firebase-admin', '@supabase/supabase-js', 'keycloak-connect', 'amazon-cognito-identity-js'] },
]; // prettier-ignore

/** Frameworks by package, grouped by the job they do; two of the same role do not mix. */
export const FRAMEWORKS: { name: string; role: 'server' | 'ui' | 'fullstack'; packages: string[] }[] = [
  { name: 'Express', role: 'server', packages: ['express'] },
  { name: 'Fastify', role: 'server', packages: ['fastify'] },
  { name: 'NestJS', role: 'server', packages: ['@nestjs/core'] },
  { name: 'Koa', role: 'server', packages: ['koa'] },
  { name: 'Hono', role: 'server', packages: ['hono'] },
  { name: 'Next.js', role: 'fullstack', packages: ['next'] },
  { name: 'Nuxt', role: 'fullstack', packages: ['nuxt'] },
  { name: 'React', role: 'ui', packages: ['react'] },
  { name: 'Vue', role: 'ui', packages: ['vue'] },
  { name: 'Angular', role: 'ui', packages: ['@angular/core'] },
  { name: 'Svelte', role: 'ui', packages: ['svelte'] },
  { name: 'Django', role: 'fullstack', packages: ['django'] },
  { name: 'Flask', role: 'server', packages: ['flask'] },
  { name: 'FastAPI', role: 'server', packages: ['fastapi'] },
  { name: 'Spring Boot', role: 'server', packages: ['org.springframework.boot:spring-boot-starter-web', 'org.springframework.boot:spring-boot-starter'] },
  { name: 'Gin', role: 'server', packages: ['github.com/gin-gonic/gin'] },
]; // prettier-ignore

/** Packages that compile native code on install, which needs a build toolchain. */
export const NATIVE_PACKAGES = new Set([
  'bcrypt', 'sharp', 'sqlite3', 'better-sqlite3', 'canvas', 'node-sass', 'node-gyp', 'argon2', 'grpc',
  'psycopg2', 'lxml', 'cryptography', 'numpy', 'pillow', 'mysqlclient',
]); // prettier-ignore

/** Loose comparison key for framework names: `Next.js`, `nextjs` and `next` are the same. */
export const frameworkKey = (name: string): string =>
  name.toLowerCase().replace(/(\.js|js)$/, '').replace(/[^a-z0-9]/g, ''); // prettier-ignore
