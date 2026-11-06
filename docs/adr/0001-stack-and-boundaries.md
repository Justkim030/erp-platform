# ADR 0001: Stack and service boundaries

**Status:** accepted for v0.1.

**Decision.** TypeScript across all services and web apps. NestJS for services, Next.js for web, PostgreSQL per service, RabbitMQ for events (later), Docker Compose for local and early deployment. A single monorepo with npm workspaces.

**Why.** One language lowers the learning load for a small team; NestJS has first-class support for modular services; PostgreSQL is a safe default for business data; a monorepo keeps shared contracts and tooling in one place.

**Consequences.** Kubernetes, Nx or Turborepo, and a separate API gateway are deferred until there are enough services to justify them. Plain SQL migrations (no ORM) keep behaviour explicit; revisit when the data model grows. Identity is built in-house for control over multi-tenancy and passkeys; Keycloak remains a fallback behind the same token contract.
