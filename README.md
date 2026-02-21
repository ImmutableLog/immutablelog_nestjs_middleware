# ImmutableLog NestJS Interceptor

Interceptor NestJS que captura automaticamente o ciclo de vida completo de cada requisição HTTP — erros, sucessos e exceções — e envia eventos de auditoria imutáveis para o ImmutableLog.

Usa RxJS (`tap` + `catchError`) e segue os padrões de injeção de dependência do NestJS. Suporta registro global, por módulo ou por controller.

---

## Instalação

Usa apenas dependências já presentes em qualquer projeto NestJS padrão:

```bash
npm install @nestjs/common @nestjs/core rxjs
```

---

## Adicionar ao projeto

Salve os dois arquivos no seu projeto:

```
src/immutablelog/immutablelog.interceptor.ts
src/immutablelog/immutablelog.module.ts
```

---

## Variáveis de ambiente

| Variável             | Obrigatório | Default            | Descrição                              |
|----------------------|-------------|--------------------|----------------------------------------|
| `IMTBL_API_KEY`      | Sim         | —                  | Chave de API do ImmutableLog           |
| `IMTBL_URL`          | Sim         | —                  | URL base da API                        |
| `IMTBL_SERVICE_NAME` | Não         | `nestjs-service`   | Nome do serviço exibido nos eventos    |
| `IMTBL_ENV`          | Não         | `production`       | Ambiente: `production`, `staging`, `development` |

> **Segurança:** use o `ConfigModule` do NestJS ou `process.env` com `.env` no `.gitignore`. Nunca hardcode o token.

---

## Registro Global (recomendado)

Importe o `ImmutableLogModule` no `AppModule` para auditar todas as rotas automaticamente:

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ImmutableLogModule } from './immutablelog/immutablelog.module';

@Module({
  imports: [
    ImmutableLogModule.forRoot({
      apiKey: process.env.IMTBL_API_KEY!,
      apiUrl: process.env.IMTBL_URL ?? 'https://api.immutablelog.com',
      serviceName: process.env.IMTBL_SERVICE_NAME ?? 'nestjs-service',
      env: process.env.IMTBL_ENV ?? 'production',
      skipPaths: ['/health', '/healthz', '/metrics'],
    }),
    // ... outros módulos
  ],
})
export class AppModule {}
```

Exemplo de `.env`:

```env
IMTBL_API_KEY=iml_live_xxxxxxxxxxxxxxxx
IMTBL_URL=https://api.immutablelog.com
IMTBL_SERVICE_NAME=meu-servico-nestjs
IMTBL_ENV=production
```

---

## Registro por Controller

Para auditar apenas controllers específicos, use `@UseInterceptors()`:

```typescript
import { Controller, Get, Post, UseInterceptors } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ImmutableLogInterceptor } from '../immutablelog/immutablelog.interceptor';

const interceptor = new ImmutableLogInterceptor(
  { apiKey: process.env.IMTBL_API_KEY! },
  new Reflector(),
);

// Por controller inteiro
@UseInterceptors(interceptor)
@Controller('payments')
export class PaymentsController {

  // Ou por método individual
  @UseInterceptors(interceptor)
  @Get('checkout')
  checkout() {
    return { status: 'ok' };
  }
}
```

---

## Parâmetros

| Parâmetro      | Tipo          | Obrigatório | Default                          | Descrição                        |
|----------------|---------------|-------------|----------------------------------|----------------------------------|
| `apiKey`       | `string`      | Sim         | —                                | Chave de API do ImmutableLog     |
| `apiUrl`       | `string`      | Não         | `https://api.immutablelog.com`   | URL base da API                  |
| `serviceName`  | `string`      | Não         | `nestjs-service`                 | Nome do serviço nos eventos      |
| `env`          | `string`      | Não         | `production`                     | Ambiente de execução             |
| `skipPaths`    | `string[]`    | Não         | `['/health', '/healthz']`        | Paths que não geram eventos      |

---

## Como funciona

O interceptor usa o padrão Observable do RxJS para interceptar o ciclo de vida completo:

| Etapa           | Descrição                                                                 |
|-----------------|---------------------------------------------------------------------------|
| `intercept()`   | Captura timestamp, `requestId` e `eventName` dos metadados do Reflector   |
| `tap()`         | Emite evento de sucesso quando o Observable completa normalmente           |
| `catchError()`  | Captura exceções, emite evento de erro e re-lança para o NestJS tratar    |

O `fetch` é fire-and-forget — **nunca bloqueia** a resposta ao cliente.

---

## Nome de evento customizado

Use o decorator `@AuditEvent()` (helper sobre `SetMetadata`) para nomear eventos por rota sem tocar no objeto `request`:

```typescript
import { SetMetadata, Controller, Post } from '@nestjs/common';
import { IMTBL_EVENT_NAME } from '../immutablelog/immutablelog.interceptor';

// Helper decorator
export const AuditEvent = (name: string) => SetMetadata(IMTBL_EVENT_NAME, name);

@Controller('payments')
export class PaymentsController {

  @AuditEvent('payment.checkout.initiated')
  @Post('checkout')
  checkout() {
    return { status: 'ok' };
  }

  @AuditEvent('payment.refund.requested')
  @Post('refund')
  refund() {
    return { status: 'ok' };
  }
}
```

O interceptor lê os metadados via `Reflector` — primeiro no método, depois no controller. Se não encontrar, usa o padrão `http.METHOD.path`.

---

## Exclusão de rotas

```typescript
ImmutableLogModule.forRoot({
  apiKey: process.env.IMTBL_API_KEY!,
  skipPaths: ['/health', '/healthz', '/metrics', '/readyz'],
})
```

---

## Payload enviado

```json
{
  "payload": "{\"id\":\"uuid\",\"kind\":\"success\",\"message\":\"POST /payments/checkout completed successfully\",\"timestamp\":\"2026-02-21T12:00:00Z\",\"context\":{\"ip\":\"1.2.3.4\",\"userAgent\":\"...\"},\"request\":{\"requestId\":\"uuid\",\"method\":\"POST\",\"path\":\"/payments/checkout\"},\"metrics\":{\"latencyMs\":22,\"statusCode\":201},\"severity\":\"low\"}",
  "meta": {
    "type": "success",
    "event_name": "payment.checkout.initiated",
    "service": "nestjs-service",
    "request_id": "uuid",
    "env": "production"
  }
}
```

> O campo `payload` é uma **string JSON serializada** — não um objeto. Isso garante que o hash SHA-256 seja calculado sobre exatamente o que foi enviado.

---

## Comportamento

| Situação                              | Resultado                                               |
|---------------------------------------|---------------------------------------------------------|
| `apiKey` vazio                        | Evento não enviado (falha silenciosa, sem exceção)      |
| Path em `skipPaths`                   | Evento ignorado, requisição prossegue normalmente       |
| Status 2xx                            | `kind: success`, `severity: low`                        |
| Status 3xx                            | `kind: info`, `severity: low`                           |
| Status 4xx / 5xx                      | `kind: error`, `severity: high`                         |
| Exceção não tratada                   | `kind: error` com `exception` e `exceptionMessage`      |
| Payload > 12KB                        | Campo `error` removido automaticamente                  |
| Falha no `fetch`                      | `console.warn` emitido; requisição não é afetada        |
