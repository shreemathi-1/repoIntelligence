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

## Health score

Signed-in users can analyse a public repository from its page. The API queues a job (Mongo-backed,
one at a time, three attempts), downloads the commit's tarball, sends it to the worker, and
collects activity, community and CI signals from GitHub. The worker runs whichever scanners are
installed: Lizard (complexity), jscpd (duplication), Ruff (Python lint), Semgrep (static
analysis), Gitleaks (secrets) and OSV-Scanner (known vulnerabilities), plus an inventory of
files that needs no tool. A scanner that is missing marks its metrics unavailable; it never
reads as a clean result. Every score stores its formula, weights, per-metric evidence and a
measured / inferred / unavailable label, and the dashboard can estimate what resolving chosen
findings would change. Limits: 5 analyses per user per day, one running at a time, archives up
to 50 MB.

Lizard and Ruff install with the worker's requirements. The others are optional:

```sh
brew install gitleaks osv-scanner        # or the release binaries from GitHub
npm install -g jscpd
services/worker/.venv/bin/pip install semgrep
```

## Architecture map

Signed-in users can map a public repository from its page. The worker parses JavaScript,
TypeScript, Python and Java with tree-sitter and returns import and symbol graphs, call and
inheritance edges, entry points, HTTP routes (Express, NestJS, FastAPI, Flask, Django, Spring),
data models and migrations (Mongoose, Prisma, SQLAlchemy, Django, JPA, Flyway), authentication
touchpoints, the tech stack, architecture layers, layer violations and import cycles. All of it
is pattern based and labelled as detected, with the file and line it came from. The page shows
module, file and symbol graphs, a folder explorer, routes with a request trace, data and auth
panels, a source viewer pinned to the commit, Mermaid exports and a comparison between two mapped
commits. A stored graph also fills the architecture area of the health score. Limits: 3,000
source files and 1 MB per file; larger repositories are mapped partially and say so.

## Repository chat

Signed-in users can ask questions about an ingested repository. Each session is pinned to the
ingested commit. Retrieval combines keyword search over the ingested chunks with vector search
over embeddings that the worker computes locally (`BAAI/bge-small-en-v1.5`, nothing leaves the
worker), merged by reciprocal rank. Names of routes, models and symbols from the architecture map
are used to sharpen the search.

Every answer cites `path:lines`. Citations are checked against the chunks the model was shown;
invented ones are removed and the answer is labelled **Cited**, **Partly supported** or **No
evidence**. When nothing relevant is found no model is called and the reply says so. Repository
text only ever reaches a model inside delimited data blocks, with an instruction to treat it as
data, and secret values are redacted on the way in and on the way out. Sessions can be exported as
Markdown, and any range of up to 120 lines can be explained line by line.

Models are reached through one gateway (`apps/api/src/llm`). Model IDs, task routing and
free-tier limits live only in `models.config.ts`. Set any of `GEMINI_API_KEY`, `GROQ_API_KEY`,
`CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY` or `OLLAMA_URL`; the gateway keeps
each provider inside its per-minute budget, retries outages with backoff and fails over to the
next model when one is rate limited. Every call's tokens are recorded; `GET /api/v1/me/llm-usage`
shows today's totals. Each user can ask 50 questions a day.

Private repositories are off by default. With the Settings opt-in, their content is routed only
to providers that do not train on inputs (Groq, Cerebras, a local Ollama); Gemini, Mistral and
OpenRouter free tiers are skipped.

Vector search runs in memory by default. On Atlas, create a Vector Search index named
`chunk_vectors` on the `chunkembeddings` collection with the definition in
`apps/api/src/models/chunk-embedding.ts`, then set `VECTOR_SEARCH_ENABLED=true`. The worker
downloads the embedding model (about 130 MB) the first time it embeds.

`npm run eval:llm` runs a fixed question set through retrieval and the configured providers and
scores citation hits, the no-evidence fallback and leaks of planted secrets or instructions.
`npm run eval:llm -- --mock` checks the pipeline without keys.

## Documentation generator

From an ingested commit, signed-in users can generate a README, a setup guide, environment
variable docs, an API reference, architecture and database schema docs, docstring suggestions, a
contributing guide, troubleshooting, Mermaid sequence diagrams, a deployment guide and a
changelog. Tables, commands, diagrams and lists are built from the repository files, the
ingestion and the architecture map, each with a `path:lines` citation. A model only writes the
explanations around them, in one call per document, and its citations are checked like chat
answers. Without a model, or for a private repository without the opt-in, documents are built
from facts alone. Sections the repository cannot support say so instead of being filled in.

Documents are edited in place with a live preview (raw HTML is never rendered; Mermaid runs in
strict mode) and export as Markdown, with links pinned to the commit or relative for committing,
or as HTML. The panel also lists missing documentation, reviews a document with rule checks and
a model score, and flags documents whose cited files changed in a newer ingested commit. Each
user can generate 10 documents a day.

Generated documents can be proposed as a draft pull request, only after the user confirms the
exact files. This needs write access: Settings links to a fresh GitHub login asking for
`public_repo` (or `repo` for private repositories). The pull request is a single commit on a new
`repointelligence/docs-<sha>` branch; the default branch is never written to.

## Scripts

| Command                | What it does                                     |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Starts the API (4000) and the web app (5173)     |
| `npm run eval:llm`     | Scores chat answers against the evaluation set   |
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
