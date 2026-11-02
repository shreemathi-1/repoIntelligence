"""Framework-level facts: entry points, routes, models, auth touchpoints and the tech stack.

Everything here is pattern based. Each detection names the file and line it came from so a
reader can check it; nothing is inferred beyond what the code literally says.
"""

import json
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

from tree_sitter import Node

from app.graph.imports import ImportEdge
from app.graph.parse import SourceFile, line_of, text, unquote, walk
from app.graph.symbols import Symbol

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "options", "head", "all"}
JS_ROUTERS = {"app", "router", "server", "api", "fastify", "r", "express", "koa", "hono"}
JAVA_MAPPINGS = {
    "GetMapping": "GET",
    "PostMapping": "POST",
    "PutMapping": "PUT",
    "PatchMapping": "PATCH",
    "DeleteMapping": "DELETE",
    "RequestMapping": "ANY",
    "GET": "GET",
    "POST": "POST",
    "PUT": "PUT",
    "DELETE": "DELETE",
    "PATCH": "PATCH",
    "Path": "ANY",
}
JS_MODEL_CALLS = {"model", "define"}
PY_MODEL_BASES = {"Base", "Model", "DeclarativeBase", "Document", "SQLModel", "BaseModel"}
JAVA_MODEL_ANNOTATIONS = {"Entity", "Document", "Table", "MappedSuperclass", "Embeddable"}
AUTH_PACKAGES = {
    "jsonwebtoken": "jwt",
    "jose": "jwt",
    "passport": "oauth",
    "next-auth": "oauth",
    "express-session": "session",
    "cookie-session": "session",
    "bcrypt": "password",
    "bcryptjs": "password",
    "argon2": "password",
    "@auth/core": "oauth",
    "lucia": "session",
    "firebase-admin": "oauth",
    "jwt": "jwt",
    "pyjwt": "jwt",
    "python-jose": "jwt",
    "authlib": "oauth",
    "passlib": "password",
    "flask_login": "session",
    "flask-login": "session",
    "django.contrib.auth": "session",
    "fastapi.security": "jwt",
    "oauthlib": "oauth",
    "org.springframework.security": "middleware",
    "io.jsonwebtoken": "jwt",
    "com.auth0": "jwt",
    "jakarta.security": "middleware",
}
AUTH_NAMES = re.compile(
    r"(?i)\b(require_?auth|authenticate|is_?authenticated|authorize|login|logout|verify_?token|sign_?in|sign_?out|current_?user|get_?current_?user|check_?permission|session)\b"
)
STACK: dict[str, tuple[str, str]] = {
    # package or import name -> (display name, category)
    "react": ("React", "framework"),
    "react-dom": ("React", "framework"),
    "next": ("Next.js", "framework"),
    "vue": ("Vue", "framework"),
    "@angular/core": ("Angular", "framework"),
    "svelte": ("Svelte", "framework"),
    "express": ("Express", "framework"),
    "fastify": ("Fastify", "framework"),
    "koa": ("Koa", "framework"),
    "@nestjs/core": ("NestJS", "framework"),
    "hono": ("Hono", "framework"),
    "mongoose": ("Mongoose", "database"),
    "mongodb": ("MongoDB driver", "database"),
    "prisma": ("Prisma", "database"),
    "@prisma/client": ("Prisma", "database"),
    "sequelize": ("Sequelize", "database"),
    "typeorm": ("TypeORM", "database"),
    "drizzle-orm": ("Drizzle", "database"),
    "pg": ("PostgreSQL driver", "database"),
    "mysql2": ("MySQL driver", "database"),
    "redis": ("Redis", "database"),
    "ioredis": ("Redis", "database"),
    "knex": ("Knex", "database"),
    "zod": ("zod", "library"),
    "pino": ("pino", "library"),
    "winston": ("winston", "library"),
    "axios": ("axios", "library"),
    "graphql": ("GraphQL", "library"),
    "@tanstack/react-query": ("TanStack Query", "library"),
    "zustand": ("Zustand", "library"),
    "redux": ("Redux", "library"),
    "tailwindcss": ("Tailwind CSS", "tooling"),
    "vite": ("Vite", "tooling"),
    "webpack": ("webpack", "tooling"),
    "typescript": ("TypeScript", "language"),
    "jest": ("Jest", "testing"),
    "vitest": ("Vitest", "testing"),
    "mocha": ("Mocha", "testing"),
    "@playwright/test": ("Playwright", "testing"),
    "cypress": ("Cypress", "testing"),
    "eslint": ("ESLint", "tooling"),
    "prettier": ("Prettier", "tooling"),
    "fastapi": ("FastAPI", "framework"),
    "flask": ("Flask", "framework"),
    "django": ("Django", "framework"),
    "starlette": ("Starlette", "framework"),
    "tornado": ("Tornado", "framework"),
    "sqlalchemy": ("SQLAlchemy", "database"),
    "alembic": ("Alembic", "database"),
    "pymongo": ("MongoDB driver", "database"),
    "psycopg2": ("PostgreSQL driver", "database"),
    "psycopg": ("PostgreSQL driver", "database"),
    "asyncpg": ("PostgreSQL driver", "database"),
    "sqlmodel": ("SQLModel", "database"),
    "peewee": ("peewee", "database"),
    "pydantic": ("Pydantic", "library"),
    "celery": ("Celery", "library"),
    "requests": ("requests", "library"),
    "httpx": ("httpx", "library"),
    "uvicorn": ("Uvicorn", "tooling"),
    "gunicorn": ("Gunicorn", "tooling"),
    "pytest": ("pytest", "testing"),
    "numpy": ("NumPy", "library"),
    "pandas": ("pandas", "library"),
    "torch": ("PyTorch", "library"),
    "ruff": ("Ruff", "tooling"),
    "mypy": ("mypy", "tooling"),
    "black": ("Black", "tooling"),
    "org.springframework.boot": ("Spring Boot", "framework"),
    "org.springframework": ("Spring", "framework"),
    "spring-boot-starter-web": ("Spring Boot", "framework"),
    "spring-boot-starter-data-jpa": ("Spring Data JPA", "database"),
    "jakarta.persistence": ("JPA", "database"),
    "javax.persistence": ("JPA", "database"),
    "org.hibernate": ("Hibernate", "database"),
    "spring-boot-starter-security": ("Spring Security", "library"),
    "org.junit": ("JUnit", "testing"),
    "junit": ("JUnit", "testing"),
    "org.mockito": ("Mockito", "testing"),
    "lombok": ("Lombok", "library"),
    "jackson-databind": ("Jackson", "library"),
    "com.fasterxml.jackson": ("Jackson", "library"),
    "io.micronaut": ("Micronaut", "framework"),
    "io.quarkus": ("Quarkus", "framework"),
    "io.vertx": ("Vert.x", "framework"),
}


@dataclass
class Detection:
    kind: str
    path: str
    line: int | None
    label: str
    evidence: str

    def to_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "path": self.path,
            "line": self.line,
            "label": self.label,
            "evidence": self.evidence[:200],
        }


@dataclass
class Route:
    method: str
    route: str
    path: str
    line: int
    framework: str
    handler: str | None
    middleware: list[str]

    def to_dict(self) -> dict[str, object]:
        return {
            "method": self.method,
            "route": self.route,
            "path": self.path,
            "line": self.line,
            "framework": self.framework,
            "handler": self.handler,
            "middleware": self.middleware,
        }


@dataclass
class Model:
    name: str
    path: str
    line: int | None
    orm: str
    kind: str

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "path": self.path,
            "line": self.line,
            "orm": self.orm,
            "kind": self.kind,
        }


@dataclass
class StackItem:
    name: str
    category: str
    version: str | None
    evidence: str

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "category": self.category,
            "version": self.version,
            "evidence": self.evidence,
        }


def _first_string_arg(args: Node | None) -> tuple[str | None, list[Node]]:
    if args is None:
        return None, []
    children = args.named_children
    for index, child in enumerate(children):
        if child.type in ("string", "template_string", "string_literal"):
            return unquote(text(child)), children[index + 1 :]
    return None, children


def _symbol_at(symbols: list[Symbol], path: str, name: str) -> str | None:
    for symbol in symbols:
        if symbol.path == path and symbol.name == name:
            return symbol.id
    return None


def _enclosing_symbol(symbols: list[Symbol], node: Node) -> str | None:
    line = line_of(node)
    best: Symbol | None = None
    for symbol in symbols:
        if symbol.line <= line <= symbol.end_line and (best is None or symbol.line >= best.line):
            best = symbol
    return best.id if best else None


def detect_in_file(
    file: SourceFile, symbols: list[Symbol], imports: list[ImportEdge]
) -> tuple[list[Detection], list[Route], list[Model], list[Detection]]:
    entries: list[Detection] = []
    routes: list[Route] = []
    models: list[Model] = []
    auth: list[Detection] = []
    root = file.tree.root_node
    own = [s for s in symbols if s.path == file.path]
    name = PurePosixPath(file.path).name

    for edge in imports:
        key = edge.external or ""
        for package, kind in AUTH_PACKAGES.items():
            if key == package or key.startswith(f"{package}.") or key.startswith(f"{package}/"):
                auth.append(Detection(kind, file.path, edge.line, package, f"imports {package}"))
                break
    for symbol in own:
        if AUTH_NAMES.search(symbol.name) and symbol.kind in ("function", "method", "class"):
            auth.append(
                Detection(
                    "handler",
                    file.path,
                    symbol.line,
                    symbol.qualified,
                    f"{symbol.kind} named {symbol.name}",
                )
            )

    if file.language in ("javascript", "typescript"):
        if name.split(".")[0] in ("index", "main", "server", "app", "cli") and PurePosixPath(
            file.path
        ).parent.name in ("", ".", "src", "bin", "server", "api"):
            entries.append(Detection("entry", file.path, 1, name, "conventional entry file name"))
        for node in walk(root):
            if node.type != "call_expression":
                continue
            fn = node.child_by_field_name("function")
            args = node.child_by_field_name("arguments")
            if fn is None:
                continue
            callee = text(fn)
            if callee.endswith((".listen", "createServer", ".serve")) or callee in (
                "serve",
                "listen",
            ):
                entries.append(
                    Detection("entry", file.path, line_of(node), callee, "starts a server")
                )
            if fn.type == "member_expression":
                obj = text(fn.child_by_field_name("object")).split(".")[-1]
                prop = text(fn.child_by_field_name("property"))
                if (
                    prop in HTTP_METHODS
                    and obj.lower() in JS_ROUTERS
                    or (prop in HTTP_METHODS and obj.lower().endswith("router"))
                ):
                    route, rest = _first_string_arg(args)
                    if route is not None and route.startswith("/"):
                        handlers = [text(c) for c in rest if c.type == "identifier"]
                        handler = (
                            _symbol_at(own, file.path, handlers[-1])
                            if handlers
                            else _enclosing_symbol(own, node)
                            if not rest
                            else None
                        )
                        routes.append(
                            Route(
                                prop.upper(),
                                route,
                                file.path,
                                line_of(node),
                                "express",
                                handler,
                                handlers[:-1],
                            )
                        )
                if prop == "use" and obj.lower() in JS_ROUTERS:
                    mount, rest = _first_string_arg(args)
                    if mount and mount.startswith("/"):
                        routes.append(
                            Route(
                                "USE",
                                mount,
                                file.path,
                                line_of(node),
                                "express",
                                None,
                                [text(c) for c in rest if c.type == "identifier"],
                            )
                        )
                if prop in ("Router", "route") and obj.lower() in JS_ROUTERS and prop == "route":
                    route, _ = _first_string_arg(args)
                    if route:
                        routes.append(
                            Route("ANY", route, file.path, line_of(node), "express", None, [])
                        )
                if prop in JS_MODEL_CALLS and obj.lower() in (
                    "mongoose",
                    "sequelize",
                    "db",
                    "database",
                ):
                    model_name, _ = _first_string_arg(args)
                    if model_name:
                        models.append(
                            Model(
                                model_name,
                                file.path,
                                line_of(node),
                                "mongoose" if obj.lower() == "mongoose" else "sequelize",
                                "model",
                            )
                        )
            elif callee == "model":
                model_name, _ = _first_string_arg(args)
                if model_name and any(e.external == "mongoose" for e in imports):
                    models.append(Model(model_name, file.path, line_of(node), "mongoose", "model"))
            if (
                callee in ("new Schema", "Schema")
                and node.parent is not None
                and node.parent.type == "variable_declarator"
            ):
                pass
        for node in walk(root):
            if node.type == "decorator":
                deco = text(node)
                if deco.startswith(("@Entity", "@Schema(", "@ObjectType")):
                    cls = node.parent
                    cls_name = text(cls.child_by_field_name("name")) if cls is not None else ""
                    models.append(
                        Model(
                            cls_name or "entity",
                            file.path,
                            line_of(node),
                            "typeorm" if "Entity" in deco else "nestjs-mongoose",
                            "model",
                        )
                    )
                if re.match(r"@(Get|Post|Put|Patch|Delete|All)\(", deco):
                    deco_method = re.match(r"@(\w+)", deco)
                    deco_route = re.search(r"\(\s*(['\"])(.*?)\1", deco)
                    routes.append(
                        Route(
                            (deco_method.group(1) if deco_method else "ANY").upper(),
                            deco_route.group(2) if deco_route else "/",
                            file.path,
                            line_of(node),
                            "nestjs",
                            _enclosing_symbol(own, node),
                            [],
                        )
                    )
    elif file.language == "python":
        if name in (
            "main.py",
            "app.py",
            "manage.py",
            "wsgi.py",
            "asgi.py",
            "__main__.py",
            "cli.py",
        ):
            entries.append(Detection("entry", file.path, 1, name, "conventional entry file name"))
        for node in walk(root):
            if node.type == "if_statement" and "__main__" in text(
                node.child_by_field_name("condition")
            ):
                entries.append(
                    Detection(
                        "entry",
                        file.path,
                        line_of(node),
                        "__main__ guard",
                        'if __name__ == "__main__"',
                    )
                )
            if node.type == "class_definition":
                supers = node.child_by_field_name("superclasses")
                bases = [
                    text(b).split("(")[0].split(".")[-1]
                    for b in (supers.named_children if supers is not None else [])
                ]
                hit = next((b for b in bases if b in PY_MODEL_BASES), None)
                if hit and hit != "BaseModel":
                    orm = (
                        "django"
                        if hit == "Model"
                        else "mongoengine"
                        if hit == "Document"
                        else "sqlmodel"
                        if hit == "SQLModel"
                        else "sqlalchemy"
                    )
                    models.append(
                        Model(
                            text(node.child_by_field_name("name")),
                            file.path,
                            line_of(node),
                            orm,
                            "model",
                        )
                    )
                if "__tablename__" in text(node) and hit is None:
                    models.append(
                        Model(
                            text(node.child_by_field_name("name")),
                            file.path,
                            line_of(node),
                            "sqlalchemy",
                            "model",
                        )
                    )
            if node.type == "decorator":
                deco = text(node).lstrip("@")
                match = re.match(
                    r"(\w+)\.(get|post|put|patch|delete|route|api_route|websocket)\(\s*(['\"])(.*?)\3(.*)",
                    deco,
                    re.S,
                )
                if match:
                    py_method = match.group(2).upper()
                    if match.group(2) in ("route", "api_route"):
                        methods = re.search(r"methods\s*=\s*\[([^\]]*)\]", match.group(5))
                        py_method = (
                            ",".join(
                                m.strip().strip("'\"").upper() for m in methods.group(1).split(",")
                            )
                            if methods
                            else "GET"
                        )
                    framework = "flask" if match.group(2) == "route" else "fastapi"
                    handler, params = _route_target(own, node)
                    routes.append(
                        Route(
                            py_method,
                            match.group(4),
                            file.path,
                            line_of(node),
                            framework,
                            handler,
                            _dependency_names(f"{deco} {params}"),
                        )
                    )
            if node.type == "call" and text(node.child_by_field_name("function")) in (
                "path",
                "re_path",
                "url",
            ):
                route, rest = _first_string_arg(node.child_by_field_name("arguments"))
                if route is not None and "urlpatterns" in text(root):
                    routes.append(
                        Route("ANY", f"/{route}", file.path, line_of(node), "django", None, [])
                    )
        if re.search(r"^(alembic/versions|migrations)/", file.path) and name not in (
            "env.py",
            "__init__.py",
        ):
            models.append(
                Model(
                    name,
                    file.path,
                    None,
                    "alembic" if "alembic" in file.path else "django",
                    "migration",
                )
            )
    else:
        for node in walk(root):
            if (
                node.type == "method_declaration"
                and text(node.child_by_field_name("name")) == "main"
                and "static" in text(node)
            ):
                entries.append(
                    Detection("entry", file.path, line_of(node), "main", "public static void main")
                )
            if node.type in ("marker_annotation", "annotation"):
                ann = text(node.child_by_field_name("name"))
                if ann == "SpringBootApplication":
                    entries.append(
                        Detection(
                            "entry",
                            file.path,
                            line_of(node),
                            "@SpringBootApplication",
                            "Spring Boot application class",
                        )
                    )
                if ann in JAVA_MODEL_ANNOTATIONS and ann != "Table":
                    cls = _annotated_declaration(node)
                    models.append(
                        Model(
                            text(cls.child_by_field_name("name")) if cls else ann,
                            file.path,
                            line_of(node),
                            "jpa" if ann != "Document" else "spring-data-mongodb",
                            "model",
                        )
                    )
                if ann in JAVA_MAPPINGS:
                    target = _annotated_declaration(node)
                    if target is None or target.type not in (
                        "method_declaration",
                        "class_declaration",
                        "interface_declaration",
                    ):
                        continue
                    ann_args = text(node.child_by_field_name("arguments"))
                    ann_route = re.search(
                        r"(?:value\s*=\s*|path\s*=\s*)?\{?\s*\"([^\"]*)\"", ann_args
                    )
                    http_method = JAVA_MAPPINGS[ann]
                    if ann == "RequestMapping":
                        found = re.search(r"RequestMethod\.(\w+)", ann_args)
                        http_method = found.group(1) if found else "ANY"
                    if target.type == "method_declaration":
                        routes.append(
                            Route(
                                http_method,
                                ann_route.group(1) if ann_route else "/",
                                file.path,
                                line_of(node),
                                "spring",
                                _enclosing_symbol(own, target),
                                [],
                            )
                        )
                    elif ann_route:
                        routes.append(
                            Route(
                                "USE",
                                ann_route.group(1),
                                file.path,
                                line_of(node),
                                "spring",
                                None,
                                [],
                            )
                        )
                if ann in ("PreAuthorize", "Secured", "RolesAllowed"):
                    auth.append(
                        Detection(
                            "middleware", file.path, line_of(node), f"@{ann}", text(node)[:80]
                        )
                    )
        if re.search(r"(^|/)db/(migration|changelog)/", file.path):
            models.append(Model(name, file.path, None, "flyway", "migration"))
    return entries, routes, models, auth


def _annotated_declaration(node: Node) -> Node | None:
    parent = node.parent
    if parent is not None and parent.type == "modifiers":
        return parent.parent
    return parent


def _route_target(own: list[Symbol], decorator: Node) -> tuple[str | None, str]:
    """The decorated function's symbol id and its parameter list text."""
    parent = decorator.parent
    if parent is None:
        return None, ""
    for child in parent.children:
        if child.type == "function_definition":
            name = text(child.child_by_field_name("name"))
            params = text(child.child_by_field_name("parameters"))
            return _symbol_at(own, own[0].path if own else "", name), params
    return None, ""


def _dependency_names(decorator_text: str) -> list[str]:
    return re.findall(r"Depends\((\w+)", decorator_text)


def migration_files(other_paths: list[str]) -> list[Model]:
    found: list[Model] = []
    for path in other_paths:
        name = PurePosixPath(path).name
        if path.endswith("schema.prisma"):
            found.append(Model("schema.prisma", path, None, "prisma", "schema"))
        elif re.search(
            r"(^|/)(migrations?|db/migrate|db/migration|db/changelog|alembic/versions)/"
            r".*\.(sql|xml|ya?ml|rb|js|ts)$",
            path,
        ):
            if "db/migration" in path:
                tool = "flyway"
            elif "db/changelog" in path:
                tool = "liquibase"
            else:
                tool = "sql" if path.endswith(".sql") else "migration"
            found.append(Model(name, path, None, tool, "migration"))
    return found


def prisma_models(root_text: dict[str, str]) -> list[Model]:
    models: list[Model] = []
    for path, body in root_text.items():
        if not path.endswith(".prisma"):
            continue
        for match in re.finditer(r"^model\s+(\w+)\s*\{", body, re.M):
            models.append(
                Model(
                    match.group(1), path, body[: match.start()].count("\n") + 1, "prisma", "model"
                )
            )
    return models


def detect_stack(
    manifests: dict[str, str], imports: list[ImportEdge], files_by_language: dict[str, int]
) -> list[StackItem]:
    items: dict[str, StackItem] = {}

    def add(key: str, version: str | None, evidence: str) -> None:
        lower = key.lower()
        hit = STACK.get(lower)
        if hit is None:
            for prefix, value in STACK.items():
                if lower.startswith(f"{prefix}.") or lower.startswith(f"{prefix}/"):
                    hit = value
                    break
        if hit is None:
            return
        name, category = hit
        current = items.get(name)
        if current is None or (current.version is None and version):
            items[name] = StackItem(name, category, version, evidence)

    for language, count in files_by_language.items():
        items[language.title()] = StackItem(
            language.title() if language != "javascript" else "JavaScript",
            "language",
            None,
            f"{count} source file(s)",
        )
    if "typescript" in files_by_language:
        items["TypeScript"] = StackItem(
            "TypeScript", "language", None, f"{files_by_language['typescript']} source file(s)"
        )

    for path, body in manifests.items():
        name = PurePosixPath(path).name
        if name == "package.json":
            try:
                data = json.loads(body)
            except ValueError:
                continue
            for group in ("dependencies", "devDependencies"):
                deps = data.get(group, {}) if isinstance(data, dict) else {}
                if isinstance(deps, dict):
                    for dep, version in deps.items():
                        add(
                            str(dep),
                            str(version).lstrip("^~") if isinstance(version, str) else None,
                            path,
                        )
        elif name == "pyproject.toml" or name.startswith("requirements"):
            for match in re.finditer(
                r"^\s*\"?([A-Za-z0-9_.-]+)\"?\s*(?:\[[^\]]*\])?\s*((?:[<>=!~]=?\s*[\w.*+-]+,?\s*)*)",
                body,
                re.M,
            ):
                spec = match.group(2).strip().rstrip(",")
                version = re.search(r"==\s*([\w.]+)", spec)
                add(match.group(1), version.group(1) if version else (spec or None), path)
        elif name == "pom.xml":
            for match in re.finditer(
                r"<artifactId>([^<]+)</artifactId>\s*(?:<version>([^<]+)</version>)?", body
            ):
                add(match.group(1), match.group(2), path)
        elif name.startswith("build.gradle"):
            for match in re.finditer(r"['\"]([\w.-]+):([\w.-]+)(?::([\w.-]+))?['\"]", body):
                add(match.group(2), match.group(3), path)
    for edge in imports:
        if edge.external:
            add(edge.external, None, f"imported in {edge.source}")
    return sorted(items.values(), key=lambda i: (i.category, i.name))
