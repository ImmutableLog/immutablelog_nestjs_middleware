# ImmutableLog NestJS Interceptor

Interceptor NestJS que captura automaticamente o ciclo de vida das requisições HTTP que chegam a um handler — erros, sucessos e exceções — e envia eventos de auditoria imutáveis para o ImmutableLog. Captura todas, exceto: paths em `skipPaths` (padrão `/health` e `/healthz`, inclusive subcaminhos como `/healthz/live`); requisições que não chegam ao interceptor — rota inexistente (404) e requisição barrada por guard (ex.: 401/403 de um `AuthGuard`) não geram evento; e, no registro por controller, as rotas fora dos controllers decorados. Com `apiKey` vazio, nada é enviado.

Usa RxJS (`tap` + `catchError`) e segue os padrões de injeção de dependência do NestJS. Suporta registro global, por módulo ou por controller.

---

## Instalação

Usa apenas dependências já presentes em qualquer projeto NestJS padrão. **Requer Node.js 18+** (o interceptor chama o `fetch` global) e a plataforma Express do Nest: o interceptor importa os tipos `Request`/`Response` de `express` e lê `req.path`, `req.route` e `req.baseUrl`.

```bash
npm install @nestjs/common @nestjs/core @nestjs/platform-express rxjs
npm install -D @types/express
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
  "payload": "{\"id\":\"uuid\",\"kind\":\"success\",\"message\":\"POST /payments/checkout completed successfully\",\"timestamp\":\"2026-02-21T12:00:00.000Z\",\"context\":{\"ip\":\"1.2.3.4\",\"userAgent\":\"...\"},\"request\":{\"requestId\":\"uuid\",\"method\":\"POST\",\"path\":\"/payments/checkout\"},\"metrics\":{\"latencyMs\":22,\"statusCode\":201},\"severity\":\"low\"}",
  "meta": {
    "type": "success",
    "event_name": "payment.checkout.initiated",
    "service": "nestjs-service",
    "request_id": "uuid",
    "env": "production",
    "environment": "production",
    "client_ip": "1.2.3.4",
    "http_method": "POST",
    "http_status": "201",
    "http_route": "/payments/checkout",
    "log_level": "info"
  }
}
```

> `env` é mantido por compatibilidade; `environment` é o nome canônico do contrato
> (`CONTRACT.md` §4.1 do `immutablelog_siem`). `client_ip`, `error_type` e `error_message`
> só aparecem quando o valor existe (IP resolvido, exceção capturada).

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
| Payload > 12 KiB (12.288 bytes)       | Remove `error`; se ainda exceder, reduz a `id`, `kind`, `message` e `timestamp` (ver "Limite efetivo do payload") |
| Falha no `fetch`                      | `console.warn` emitido; requisição não é afetada        |
| API responde não-2xx (401, 429, 5xx)  | `console.warn` com o status; evento não é reenviado     |

---

## Limitações conhecidas

- **Dados que vão selados.** O evento selado não pode ser apagado depois. O interceptor **não** envia body, hash do body nem query string (`request.path` é `req.path`, sem a query) — por isso não tem a redação de query dos middlewares Express e Fastify. O `payload` leva `context.userAgent` e o path concreto.
- **`client_ip`.** Vem do **primeiro item** do header `X-Forwarded-For`, sem depender de `trust proxy`, desde que seja um IP: espaços, porta e colchetes saem (`203.0.113.7:4711` vira `203.0.113.7`, `[2001:db8::1]:8080` vira `2001:db8::1`) e o resto passa por `net.isIP`, sem DNS. Se o header faltar ou o primeiro item não for IP (ex.: `localhost`, lixo), cai no IP da conexão, `req.socket.remoteAddress` (pode vir como `::ffff:1.2.3.4`). Se nenhum dos dois for IP, `client_ip` não é enviado, nem no `meta` nem em `payload.context.ip`. Sem proxy na frente, o próprio chamador **forja** o valor mandando o header. Atrás de proxy que acrescenta ao header em vez de sobrescrevê-lo, o primeiro item continua sendo o que o cliente mandou. O mesmo valor vai em `payload.context.ip`. **Só vale para quem copiar esta versão:** cópia anterior do interceptor mandava o primeiro item cru (com porta ou lixo, e o SIEM descartava o campo em silêncio) e `"unknown"` em `payload.context.ip` quando não havia IP.
- **`Idempotency-Key`.** É o `id` do payload, um `randomUUID()` novo por evento — não deriva da requisição. O header `Request-Id` e `meta.request_id` usam o `x-request-id` recebido, sem validação, ou um UUID gerado; o valor é devolvido no header `x-request-id` da resposta.
- **Entrega.** Um único `POST {apiUrl}/v1/events` por evento, disparado sem `await`: sem timeout, sem retry, sem fila. Erro de rede gera `console.warn` e o evento se perde. Resposta HTTP não-2xx da API (401, 429, 5xx) gera `console.warn` com o status, sem retry: o evento não é reenviado. Aplicação com cópia anterior do interceptor não tem esse aviso até recopiar o arquivo.
- **Exceção.** O status vem de `err.status ?? err.statusCode ?? 500`; `error_type` é o nome da classe do erro. A exceção é relançada para o Nest tratar.
- **`error_message`.** Truncado em 500 caracteres no `meta`; a mensagem vai inteira em `payload.error.exceptionMessage`.
- **`env`.** A opção `env` (padrão `production`) vai em `meta.environment` e repetida em `meta.env`.
- **Campos reservados enviados no `meta`:** `service`, `environment`, `http_method`, `http_status` (string), `http_route` (template `baseUrl + route.path`, ou o path concreto quando não houve rota), `log_level` (`error` ou `info`) sempre; `error_type` e `error_message` só no evento de exceção (`catchError`). Além deles: `type`, `event_name`, `request_id`, `env` e `client_ip` (omitido se o IP não for resolvido).
- **Sem trilha.** Não há suporte a `immutable_trail`.

### Limite efetivo do payload

O limite é de 12.288 bytes (12 KiB) de JSON serializado em UTF-8. Se remover `error` não for suficiente, o evento é reduzido a `id`, `kind`, `message` e `timestamp`, com strings limitadas (`message` em 500 caracteres, `id` em 128, `timestamp` em 64) e nova verificação do tamanho; se mesmo assim exceder, sobra só `{"kind": ..., "message": "Event payload exceeded size limit"}`. Nesse fallback, contexto, request, métricas e `severity` são omitidos. O evento continua sendo enviado. Quando é o `error` que sai (ex.: exceção com mensagem enorme), `meta.error_type` e `meta.error_message` (truncado em 500) continuam no evento, mas `payload.error.exceptionMessage` não. O limite vale só para o `payload`: o `meta` não é reduzido. **Só vale para quem copiar esta versão:** cópia anterior do interceptor mantinha contexto e request no fallback e podia enviar payload acima de 12 KiB (ex.: path ou user-agent gigantes) até recopiar o arquivo.
