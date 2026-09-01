# API e protocolo

Base: `/api/v1`. JSON simples — não implementamos o protocolo multipart do Expo (controlamos os dois lados; complexidade sem ganho aqui).

## 1. Autenticação

| Superfície | Mecanismo |
|---|---|
| Device API | `x-ota-app-key` (chave **pública** do projeto — identifica, não autoriza admin; conteúdo é protegido por assinatura, não por segredo no client) |
| Admin API — **tudo** (dashboard, `ota console`, CLI, MCP, CI) ✅ | `Authorization: Bearer ota_...` — token opaco, hash no banco, escopo por org/projeto, `admin`/`read`. `POST /auth/login` (e-mail+senha) emite um token; a SPA guarda em localStorage. Sem cookies: um mecanismo só funciona nos 3 targets e no console local (sem CORS/SameSite). |
| MCP remoto (`/mcp`) ✅ | **OAuth 2.1 + PKCE + Dynamic Client Registration** — o server é o authorization server: `/.well-known/oauth-protected-resource` · `/oauth/register` · `/oauth/authorize` (tela de login/consent) · `/oauth/token` (+ refresh). Access tokens = `api_tokens` (kind `oauth`, com expiração) — um sistema de tokens só. Fallback: header `Authorization: Bearer ota_...` direto. |

## 2. Device API (protocolo SDK↔servidor)

### 2.1 `GET /update-check`

```
x-ota-app-key: pk_a1b2...
?platform=android
&channel=production
&runtime=fp_9f8e7d...        # fingerprint do binário
&current=0193a0...           # release id atual; ausente = rodando embarcado
&floor=01939f...             # embeddedFloorId gerado no build
&native=1.4.2                # versionName / CFBundleShortVersionString
&device=3f7a...              # UUID anônimo
&failed=0193a1...,0193a2...  # releases que falharam neste device (cap: últimas 10)
```

**Semântica (target release):**

1. Candidatas: `project+platform+channel` batem, `runtime_version == runtime` (match exato), `id > floor`, `id ∉ failed`, e:
   - `status = 'active'` e device dentro do rollout (§2.2), **ou**
   - `id == current` com `status IN ('active','paused')` — sticky: quem já tem, mantém.
2. `target = max(id)` das candidatas.
3. Resposta:
   - `target == current` → `{"action":"none"}`
   - `target` existe e difere → `{"action":"update", ...}` (serve para upgrade **e** downgrade — ex.: current foi `disabled` e o alvo é a release anterior)
   - sem candidatas e `current` não roda mais (`disabled`/inexistente) → `{"action":"rollBackToEmbedded"}`
   - sem candidatas mas `current` segue válida → `none`
4. Efeitos colaterais: upsert do device (throttle 1h) — este request **é** o heartbeat de telemetria.

```json
{ "action": "update",
  "mandatory": false,
  "manifest": {
    "id": "0193a4c8-...", "projectId": "prj_...", "platform": "android",
    "channel": "production", "runtimeVersion": "fp_9f8e7d...",
    "label": 42, "sha256": "b94d27b9...", "size": 4812345,
    "createdAt": "2026-09-01T12:00:00Z"
  },
  "signature": "base64(RSA-SHA256(manifest canônico))",
  "url": "https://cdn.exemplo.com/bundles/prj_x/0193a4c8.zip"
}
```

**`url` fica fora do manifest assinado** de propósito: é só transporte (pode mudar de CDN/domínio sem invalidar assinaturas antigas); integridade vem do `sha256`, autenticidade da assinatura. Um atacante que troque a `url` só consegue entregar um zip que não bate o hash → rejeitado.

### 2.2 Rollout bucketing (determinístico, sem estado)

```
bucket = int(sha256(deviceId + ":" + releaseId)[0:8]) % 10000   # 0–9999
oferecida se bucket < rollout_percent * 100
```

- Salt por release (`releaseId` no hash): um device não cai sempre nos "primeiros 10%" de toda release.
- **Sticky por construção**: aumentar % só adiciona devices; reduzir não remove quem já instalou (só `disabled` remove). UI recomenda increase-only e avisa ao reduzir.
- Zero estado no servidor: nada de tabela release×device.

### 2.3 `POST /events`

```json
{ "device": "3f7a...",
  "events": [
    {"type": "download",     "release": "0193a4...", "ts": 1756731600},
    {"type": "install",      "release": "0193a4...", "ts": 1756731610},
    {"type": "ready",        "release": "0193a4...", "ts": 1756731620},
    {"type": "rollback",     "release": "0193a4...", "ts": 1756731699,
     "meta": {"reason": "crash", "from": "0193a3..."}},
    {"type": "verifyFailed",  "release": "0193a4...", "ts": 0, "meta": {"stage": "sha256"}}
  ] }
```

`202 Accepted`. Batch enviado em launch/background com retry e fila em disco no SDK; servidor incrementa `release_stats` numa transação e insere `rollback_events` quando aplicável. Idempotência estrita não é necessária (contadores operacionais).

### 2.4 `GET /preview/manifest?d=<payload>&s=<sig>`

Valida o token de preview (§4.3) server-side e devolve o mesmo formato do update-check (`manifest + signature + url`). Só releases do projeto do token; `exp` respeitado.

## 3. Admin API (dashboard = CLI = MCP)

| Método/rota | Função |
|---|---|
| `GET /meta` · `GET /config` (alias) | **público**: `{mode, hosted, billingEnabled, signupEnabled, version}` — o dashboard usa para esconder signup/billing num self-host |
| `GET /plans` | **público**: catálogo de planos (preço não é segredo); alimenta a tela de billing |
| `GET /healthz` | liveness: modo, driver de storage, billing ligado |
| `PUT/GET /storage/:key` | **só no driver `local`** (que não assina URL): passthrough de upload/download. Recusa release que não esteja `pending`, valida o formato da key e aplica o teto de tamanho |
| `POST /auth/signup` · `POST /auth/verify-email` | hosted ✅: cria conta → e-mail de verificação (`sendEmail`: Resend/SMTP) → verifica → cria org no plano free/trial. `OTA_MODE=self`: signup fechado após o primeiro usuário |
| `POST /auth/login` | e-mail+senha → `{token}` (Bearer; revogável em settings) |
| `GET /orgs` · `GET /orgs/:id/usage` | org e uso vs quota. Gestão de membros (convites, PATCH/DELETE) **ainda não implementada** — roles existem no schema e valem para billing |
| `POST /billing/checkout` · `POST /billing/portal` · `POST /billing/webhook` | hosted ✅: Stripe checkout session, customer portal, webhooks idempotentes (`stripe_events`) |
| `GET /orgs/:id/usage` | uso vs quotas do plano (projetos, devices ativos/30d, storage) |
| `POST/GET /mcp` | MCP Streamable HTTP (§1) — mesmas tools do `ota mcp` stdio |
| `GET/POST /projects` | criar gera par RSA + `app_key` + canais default |
| `GET /projects/:id` · `GET /projects/:id/public-key` | |
| `GET /projects/:id/overview` | home: release atual/canal, saúde, adoção, rollbacks recentes |
| `GET /projects/:id/releases?channel&platform&status&cursor` | |
| `POST /projects/:id/releases/prepare-upload` | **publish ①**: `{sha256, size, platform, channel, runtime, rollout?, mandatory?, message?, gitCommit?, groupId?}` → `{releaseId, uploadUrl}` (URL assinada do storage adapter, TTL curto) |
| `PUT <uploadUrl>` | **publish ②**: CLI envia o zip **direto ao storage** — nunca atravessa a API (viável em edge functions) |
| `POST /releases/:id/confirm` | **publish ③**: server valida via `head()` (existência/tamanho; re-hash oportunista no Node), assina o manifest com o sha256 declarado e ativa a release. Release não confirmada expira e é limpa |
| `GET /releases/:id` · `GET /releases/:id/metrics` | funil + série diária |
| `PATCH /releases/:id` | `{status? rolloutPercent? mandatory? message?}` |
| `POST /releases/:id/promote` | `{channel, rolloutPercent?}` → copia p/ canal destino |
| `POST /releases/:id/rollback` | açúcar p/ `status=disabled` com entrada no audit (v2) |
| `POST /releases/:id/preview-link` | `{ttlMinutes=15}` → `{url}` (QR é client-side) |
| `GET /projects/:id/distribution?platform&window=30` | por release OTA e por versão nativa |
| `GET/POST/DELETE /projects/:id/tokens` · `/channels` | |

Erros: `{ "error": { "code": "release_not_found", "message": "..." } }`, HTTP semântico. Paginação por cursor (id UUIDv7 já ordena por tempo).

## 4. Segurança e assinatura

### 4.1 Chaves

- **Par RSA-2048 por projeto**, gerado na criação. Privada: só no servidor, AES-256-GCM com `OTA_MASTER_KEY`. Pública: baixada no `ota init` → `ota.config.json` (commitada) → embutida no binário pelo config plugin.
- Escopo de comprometimento: vazar a chave de um projeto não afeta outros. Rotação (v2): binário embute lista de pubkeys, manifest ganha `keyId`.
- RSA vs Ed25519 ✅ (validado 2026-09-01): Ed25519 é melhor criptografia, mas exige dependência no Android < API 33; RSA-SHA256 verifica com API nativa em qualquer iOS/Android. Escolha: RSA. Trocar depois é adicionar `alg` ao manifest.

### 4.2 Assinatura de release

- **JSON canônico** do manifest (chaves ordenadas, sem espaços, UTF-8) → `RSA-PKCS#1v1.5 + SHA-256` → assinatura destacada base64. Sem JWT: parser JWT nativo seria dependência extra para envelopar exatamente os mesmos bytes.
- O `sha256` do manifest vem da CLI (upload direto ao storage — ARCHITECTURE §3.1). Fronteira de confiança: o token admin que autoriza o publish. A assinatura atesta "o servidor deste projeto aprovou uma release com este hash" e protege contra adulteração pós-publish; um publisher malicioso poderia publicar conteúdo malicioso com hash correto de qualquer forma — o risco é idêntico ao multipart. Onde re-verificar é barato (Node self-host), o server confere o hash antes de ativar.
- Verificação no device (nativa, antes de qualquer uso):
  1. recompõe o JSON canônico do manifest recebido;
  2. verifica assinatura com a pubkey embutida — falhou → descarta + `verify_failed`;
  3. `manifest.projectId`/`platform`/`runtimeVersion` batem com o binário;
  4. baixa o zip → `sha256(zip) == manifest.sha256` — falhou → descarta + `verify_failed`;
  5. só então extrai e agenda.
- Um artefato = um hash (zip inteiro). Hash por asset individual (modelo Expo) só faz sentido com download parcial/diffs — futuro.

**Threat model:**

| Ameaça | Mitigação |
|---|---|
| Storage/CDN comprometido, MITM, URL trocada | assinatura + sha256 verificados no device — código não assinado nunca executa |
| Replay de release antiga (downgrade attack) | servidor decide o target; `floor` impede OTA < binário; manifest amarra `runtimeVersion` |
| Manifest de outro projeto/app | `projectId` + assinatura por chave do projeto (pubkey de outro app não valida) |
| Servidor comprometido | game over por definição (ele assina). Reduzir superfície: master key em secret manager, servidor pequeno, audit log |
| `app_key` conhecida por terceiros | é pública por design; não autoriza nada além de receber conteúdo assinado e publicar contadores. Rate limit por IP/device contra poluição de métricas |
| Device pede canal `staging` sem ser build de QA | aceito no MVP (bundles de staging não são secretos e são assinados). ⚖️ Se incomodar: flag `restricted` no canal + chave por canal |

### 4.3 Token de preview (deep link / QR)

Payload canônico assinado com a **mesma chave do projeto** (o device já tem a pubkey):

```json
{"purpose":"preview","projectId":"prj_...","releaseId":"0193a4...","exp":1756732500}
```

`myapp://ota/preview?d=<b64url(payload)>&s=<b64url(assinatura)>`

Validação no SDK: assinatura ✓ → `purpose == "preview"` (domain separation: um token de preview nunca é confundível com um manifest) → `projectId` é o meu → `exp` no futuro (tolerância ±5 min p/ clock skew do device; o server valida `exp` sem tolerância) → busca manifest via `/preview/manifest` (servidor revalida: expiração curta funciona como revogação; release precisa existir e pertencer ao projeto) → verificação normal de manifest+hash → aplica **pinned**.

Propriedades: conhecer `releaseId`/hash **não basta** — precisa de assinatura do servidor; token expira (15 min default); vinculado a projeto e release específicos; replay dentro da janela é aceito (feature de teste — o conteúdo instalável é o mesmo que o rollout entregaria, autenticado identicamente; não há escalação de privilégio); token não dá acesso à Admin API (endpoint de preview só devolve manifest). Pinned = update-check suspenso até `exitPreview()` ou reinstalação.

### 4.4 Transporte e abuso

TLS obrigatório (assinatura protege conteúdo, TLS protege metadados/privacidade). Rate limits: `/update-check` e `/events` por device+IP; `/auth/login` com backoff. Uploads limitados (ex.: 200 MB) e só por token `admin` do projeto.

---

## 5. Estado da implementação

Esta seção reflete o código, não o plano. Onde houver divergência com as seções acima, o código manda.

| Área | Estado |
|---|---|
| Device API (`/update-check`, `/events`, `/preview/manifest`) | implementado, com a decisão de target extraída como função pura (`decideTarget`) e coberta por 17 testes |
| Admin API | implementado (projects, channels, releases, prepare/confirm, patch, promote, rollback, preview-link, metrics, distribution, rollbacks, tokens) |
| Assinatura | RSA-2048/SHA-256 sobre JSON canônico, via Web Crypto — mesmo código em Node, Deno e Workers. Vetores em `packages/shared/test/vectors/` mantêm Kotlin e Swift em sincronia |
| Telemetria | upsert de device com throttle de 1h + contadores diários; dobra de eventos como função pura testada |
| Auth | Bearer-only; PBKDF2-HMAC-SHA256 a 600k iterações (argon2 exigiria módulo nativo, que não roda em edge). O formato armazenado carrega os parâmetros, então subir o custo é migração e não reescrita |
| Storage | S3-compatível, Supabase Storage e disco local. Adapter declara `readsAreCheap`; onde é barato, o server reconfere o digest no confirm |
| Banco | Postgres, um dialeto. Migrations versionadas; a suíte de integração roda **essas mesmas migrations** num Postgres real embarcado (PGlite), sem Docker |

Testes: a contagem vive no CI e no badge do README — número fixo aqui só envelhece. O que **não** foi validado ainda é o que só hardware resolve — boot path nativo e resolução de assets offline em iOS/Android reais, nas duas arquiteturas do React Native.

### 5.1 Correções encontradas na integração

Coisas que só apareceram quando as peças foram ligadas umas às outras — registradas porque cada uma teria virado bug em produção:

| O quê | Consequência se tivesse passado |
|---|---|
| `publish_release` lia um caminho do disco do servidor | Em modo hosted, qualquer token admin conseguiria fazer o server abrir um arquivo local e devolver o conteúdo pelo bundle publicado. Removido: sobre HTTP a tool só confirma upload já feito pela CLI |
| MCP stdio e MCP HTTP divergiam nos argumentos | Mesma tool, chamadas incompatíveis: um agente conectado por stdio passava `releaseId`, por HTTP `projectId` + `release`. Contrato unificado em `packages/shared/src/mcp.ts`, com teste de conformidade |
| Device preso em release que ele próprio marcou como falha | O servidor respondia `none` e o app ficava em crash loop. Agora "current ainda válida" exclui releases na lista de falhas |
| Unidades de taxa divergentes entre clientes | Dashboard e CLI assumiram razão 0–1; a API devolve 0–100. Uma taxa de rollback de 50% apareceria como 5000% |
| `db.execute()` com formato de retorno por driver | A query de distribuição quebrava fora do postgres-js. Reescrita no query builder |
| Re-verificação de digest chaveada pelo nome do driver | Adapters que podiam reler barato eram pulados. Virou capacidade declarada (`readsAreCheap`) |
| `drizzle-orm` < 0.45.2 | Escape indevido de identificadores SQL num servidor com banco. Atualizado |
