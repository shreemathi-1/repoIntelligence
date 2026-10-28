# 0001. Monorepo and stack

Status: accepted

## Context

RepoIntelligence has a web client, an API, a Python analysis worker and code shared between
them. It is a personal project for now and has to run on free tiers only. A public launch may
follow, so the structure should not need a rewrite later.

## Decision

- One git repository using npm workspaces (`@repointelligence/*`): `apps/web`, `apps/api`,
  `packages/shared`. The worker lives in `services/worker` as a separate Python project.
- Web: React 18, Vite, TypeScript, Tailwind, shadcn/ui, React Router, TanStack Query, Zustand.
- API: Node 22, Express, TypeScript, Mongoose, zod, pino, Octokit. MongoDB Atlas M0 for data.
- Worker: Python 3.12 and FastAPI. Scanners and parsers (tree-sitter) go here later because
  the good tooling for them is in Python.
- `packages/shared` holds zod schemas, so the API and the web client validate the same shapes.
- Business routes are versioned under `/api/v1`. `/health` is unversioned so probes stay stable.
- All LLM calls go through one gateway module in the API. Model IDs live in a single config
  file and provider keys never leave the server.
- Scanners produce the metrics; the LLM only explains them. Missing data is reported as
  unavailable, never as zero. Repository content is treated as untrusted data.

## Consequences

- One install, one lint and one test command cover the TypeScript side. The worker has its
  own Ruff, mypy and pytest setup, run by its own CI job.
- The shared package has to be built before the apps can typecheck or test, so the root
  scripts do that first.
- Docker packaging for the worker is postponed until the rest of the project is working.
- Two toolchains (Node and Python) means two sets of dependencies to keep current.
