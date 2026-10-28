# RepoIntelligence

RepoIntelligence helps developers find, understand and judge GitHub repositories: health
scores, architecture graphs, repo chat with citations, adaptability reports and
implementation plans.

It is a personal project and is built to run on free tiers only. This repository currently
contains the foundation: tooling, the API, the web shell and the worker skeleton.

## Layout

| Path              | What it is                                        |
| ----------------- | ------------------------------------------------- |
| `apps/web`        | React + Vite client                               |
| `apps/api`        | Express API (MongoDB via Mongoose)                |
| `packages/shared` | zod schemas and types used by the API and the web |
| `services/worker` | FastAPI worker for scanners (Python)              |
| `docs/adr`        | Architecture decision records                     |

## Setup

You need Node 22 or newer, Python 3.12 and a MongoDB database (an Atlas M0 cluster works).

```sh
npm install
cp .env.example .env        # then fill in MONGODB_URI and WORKER_SHARED_SECRET

python3.12 -m venv services/worker/.venv
services/worker/.venv/bin/pip install -r services/worker/requirements.txt \
  -r services/worker/requirements-dev.txt
```

## GitHub login

Login is optional while developing. To enable it, register an OAuth App on GitHub with the
callback `http://localhost:4000/api/v1/auth/github/callback`, then set `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`, `JWT_SECRET` (32+ characters) and
`TOKEN_ENCRYPTION_KEY` in `.env`. Generate the key with `openssl rand -base64 32`. These are
all-or-nothing: with none set, the auth routes answer 503; with only some set, the API refuses
to start.

## Discovery and trending

Search, trending, compare and profiles work without signing in. Set an optional read-only
`GITHUB_TOKEN` (no scopes) so anonymous browsing gets GitHub's higher rate limit. Trending lists
are our own estimate, built by a daily job: set `TRENDING_JOB_ENABLED=true` to run it inside the
API at 03:00 UTC, or fill the lists on demand with `npm run job:trending`.

## Ingestion

Signed-in users can ingest a repository from its page (`/repo/owner/name`). The API pins the
default branch (or a ref you give) to a commit, reads the file tree through GitHub's API without
cloning, and stores what it extracts keyed by repository and commit: Markdown structure with
links checked against the tree, OpenAPI operations, dependency manifests, `.env.example`
variables, and pattern-based symbols with their doc comments. Limits are 2,000 files, 1 MB per
file, 20 MB in total and about 60 seconds; a result that hits one is marked partial. Exports
(Markdown, JSON, plain text, and a token-budgeted context bundle) are downloads from
`/api/v1/repos/:owner/:name/ingestions/:sha/export`. Repository text is always treated as data.

## Scripts

| Command                | What it does                                     |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Starts the API (4000) and the web app (5173)     |
| `npm run job:trending` | Rebuilds the trending lists once                 |
| `npm run dev:worker`   | Starts the worker on port 8000                   |
| `npm run lint`         | ESLint across the TypeScript packages            |
| `npm run typecheck`    | Builds shared, then typechecks every workspace   |
| `npm test`             | Builds shared, then runs every workspace's tests |
| `npm run lint:worker`  | Ruff and mypy for the worker                     |
| `npm run test:worker`  | pytest for the worker                            |
| `npm run format`       | Prettier                                         |

Commits follow Conventional Commits, checked by a commit-msg hook. The allowed scopes are
`api`, `web`, `worker`, `shared`, `docs`, `ci`, `deps` and `repo`.

## License

MIT, see [LICENSE](LICENSE).
