"""Three small repositories, one per language, with known structure."""

EXPRESS_TS: dict[str, bytes | str] = {
    "package.json": '{"name":"shop","main":"src/index.ts","scripts":{"start":"node dist/index.js"},"dependencies":{"express":"^5.0.0","mongoose":"^8.0.0","jsonwebtoken":"^9.0.0","zod":"^3.23.0"},"devDependencies":{"vitest":"^2.0.0","typescript":"^5.6.0"}}',
    "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    "src/index.ts": "import express from 'express';\nimport { router } from './routes/orders.js';\nimport { requireAuth } from '@/middleware/auth';\n\nconst app = express();\napp.use('/api', requireAuth, router);\napp.listen(3000);\n",
    "src/routes/orders.ts": "import { Router } from 'express';\nimport { listOrders, createOrder } from '../services/orders.js';\n\nexport const router = Router();\nrouter.get('/orders', listOrders);\nrouter.post('/orders', createOrder);\n",
    "src/services/orders.ts": "import { Order } from '../models/order.js';\nimport { notify } from '../clients/mailer.js';\n\nexport async function listOrders(req: unknown, res: unknown) {\n  return Order.find();\n}\n\nexport async function createOrder(req: unknown, res: unknown) {\n  const order = await Order.create({});\n  notify(order);\n  return order;\n}\n",
    "src/models/order.ts": "import mongoose, { Schema } from 'mongoose';\nimport { listOrders } from '../services/orders.js';\n\nconst orderSchema = new Schema({ total: Number });\nexport const Order = mongoose.model('Order', orderSchema);\nexport class BaseEntity {}\nexport class Audited extends BaseEntity {}\n",
    "src/clients/mailer.ts": "export function notify(order: unknown): void {}\n",
    "src/middleware/auth.ts": "import jwt from 'jsonwebtoken';\n\nexport function requireAuth(req: unknown, res: unknown, next: () => void): void {\n  jwt.verify('t', 's');\n  next();\n}\n",
    "src/index.test.ts": "import { describe } from 'vitest';\ndescribe('x', () => {});\n",
}

FASTAPI_PY: dict[str, bytes | str] = {
    "pyproject.toml": '[project]\nname = "inventory"\ndependencies = ["fastapi>=0.115", "sqlalchemy==2.0.30", "python-jose"]\n',
    "app/__init__.py": "",
    "app/main.py": 'from fastapi import FastAPI\n\nfrom app.api.items import router\n\napp = FastAPI()\napp.include_router(router)\n\nif __name__ == "__main__":\n    import uvicorn\n\n    uvicorn.run(app)\n',
    "app/api/__init__.py": "",
    "app/api/items.py": 'from fastapi import APIRouter, Depends\n\nfrom app.services.items import list_items\nfrom app.security import get_current_user\n\nrouter = APIRouter()\n\n\n@router.get("/items")\ndef read_items(user=Depends(get_current_user)):\n    return list_items()\n\n\n@router.post("/items", status_code=201)\ndef create_item():\n    return {}\n',
    "app/services/__init__.py": "",
    "app/services/items.py": "from app.models.item import Item\n\n\ndef list_items():\n    return Item.query()\n",
    "app/models/__init__.py": "",
    "app/models/item.py": 'from sqlalchemy.orm import DeclarativeBase\n\n\nclass Base(DeclarativeBase):\n    pass\n\n\nclass Item(Base):\n    __tablename__ = "items"\n',
    "app/security.py": 'from jose import jwt\n\n\ndef get_current_user():\n    return jwt.decode("t", "s")\n',
    "alembic/versions/0001_init.py": "def upgrade():\n    pass\n",
    "tests/test_items.py": "from app.services.items import list_items\n\n\ndef test_list():\n    assert list_items\n",
}

SPRING_JAVA: dict[str, bytes | str] = {
    "pom.xml": "<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.3.0</version></dependency><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency></dependencies></project>",
    "src/main/java/demo/Application.java": "package demo;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class Application {\n    public static void main(String[] args) {\n        SpringApplication.run(Application.class, args);\n    }\n}\n",
    "src/main/java/demo/web/AccountController.java": 'package demo.web;\n\nimport demo.service.AccountService;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.PostMapping;\nimport org.springframework.web.bind.annotation.RequestMapping;\nimport org.springframework.web.bind.annotation.RestController;\nimport org.springframework.security.access.prepost.PreAuthorize;\n\n@RestController\n@RequestMapping("/accounts")\npublic class AccountController {\n    private final AccountService service;\n\n    @GetMapping("/{id}")\n    @PreAuthorize("hasRole(\'USER\')")\n    public String find(long id) {\n        return service.find(id);\n    }\n\n    @PostMapping\n    public String create() {\n        return service.create();\n    }\n}\n',
    "src/main/java/demo/service/AccountService.java": 'package demo.service;\n\nimport demo.data.AccountRepository;\n\npublic class AccountService {\n    private final AccountRepository repository;\n\n    public String find(long id) {\n        return repository.load(id);\n    }\n\n    public String create() {\n        return "";\n    }\n}\n',
    "src/main/java/demo/data/AccountRepository.java": "package demo.data;\n\nimport demo.data.Account;\n\npublic interface AccountRepository {\n    String load(long id);\n}\n",
    "src/main/java/demo/data/Account.java": "package demo.data;\n\nimport jakarta.persistence.Entity;\n\n@Entity\npublic class Account extends BaseEntity {\n    private long id;\n}\n",
    "src/main/java/demo/data/BaseEntity.java": "package demo.data;\n\npublic abstract class BaseEntity {}\n",
    "src/main/resources/db/migration/V1__init.sql": "create table account (id bigint);\n",
}
