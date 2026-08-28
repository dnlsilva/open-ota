# Plano de construção

**Sem MVP** (decisão de Daniel, 2026-09-01): o escopo completo sai de uma vez, num único projeto — os requisitos originais inteiros + as decisões validadas. O que segue não é corte de escopo: é **ordem de construção por dependência e risco**, para que cada etapa termine executável e testável.

## 1. Escopo v1 (completo)

- **Server** (Hono, um codebase): Device API (update-check com target-release + rollout bucketing, events, preview), Admin API completa, assinatura RSA por projeto, telemetria por contadores, auth Bearer-only (login emite token opaco; label sequence em transação; migrations automáticas no boot).
- **Três deploy targets**: Supabase (Edge Function + Postgres + Storage, provisionado em um comando), Cloudflare (Workers + Hyperdrive/R2), Docker self-host (Node + Postgres + MinIO/S3), mais o modo hosted. Postgres em todos; a costura que varia é o storage adapter.
- **SDK** React Native/Expo (Expo Modules API), **Old + New Architecture** (RN 0.73+/Expo SDK 50+): boot path nas variantes bridge e bridgeless, slots A/B, download/verify (assinatura + sha256), rollback automático (1 crash), notifyAppReady, eventos, deviceId, canais em runtime, deep link de preview pinned. Exige dev build (Expo Go não suporta módulo nativo — nota de docs).
- **Autoconfig de setup**: Expo config plugin **e** codemods para bare RN (paridade), deep links inclusos; `ota doctor` valida ambos.
- **CLI** `ota`: login, init (com `--provider`), fingerprint, publish (upload direto ao storage), releases, promote, rollout, pause/resume/disable, rollback, metrics, preview (QR no terminal), console (dashboard local), doctor, mcp.
- **Dashboard** SPA: home do projeto (saúde/adoção/distribuição), releases (agrupadas por group_id), release detail (funil, série diária, rollout slider, ações, QR "Open on device"), devices/distribuição (OTA + versão nativa), settings (canais, tokens, chave pública).
- **MCP server**: tools únicas (packages/shared) em **dois transportes** — stdio (`ota mcp`) e remoto Streamable HTTP em `/mcp` com **OAuth 2.1 + PKCE + DCR** ("conectar e funcionar bala" no hosted; self-hosts ganham a rota também). ~14 tools do ARCHITECTURE §3.5, incluindo QR como image content.
- **Modo hosted (SaaS)**: multi-tenant (orgs/membership/roles), signup self-serve com e-mail verificado (`sendEmail`: Resend/SMTP), **Stripe completo** (checkout, portal, webhooks idempotentes, trial, upgrade/downgrade), quotas por plano com enforcement (bloqueia publish, nunca corta apps em produção). Self-host = `OTA_MODE=self`, org default invisível.
- **Dashboard**: rollout % controlado por grupo (aplica nas releases iOS+Android do mesmo publish).
- **App exemplo** (Expo) como harness de ponta a ponta, com E2E via Maestro; segundo harness bare RN (old arch) para a matriz.
- **Licença MIT** desde o primeiro commit.

Fora do v1 (extensões, não pendências): diffs .bsdiff, auto-halt por taxa de rollback, estratégia appVersion/semver, rotação de chaves (keyId), SSO/SAML, ClickHouse, audit log completo. (Orgs/RBAC básico **entrou** no v1 com o modo hosted.)

## 2. Ordem de construção

Dependência e risco mandam: o que pode inviabilizar (SDK nativo) é atacado primeiro via spike; providers extras entram depois que o caminho feliz existe em um provider.

| Etapa | Entrega | Depende de |
|---|---|---|
| E0 | Monorepo pnpm · packages/shared (tipos, JSON canônico, assinatura, client API) · docker-compose dev (pg+minio) · CI | — |
| E1 | **Spike de risco**: boot path injetado + zip do `expo export` extraído rodando offline com assets, nos dois SOs | E0 |
| E2 | Server core no target Node: projects/keys, prepare/confirm upload, update-check completo, tokens, adapters db(pg)+storage(s3) | E0 |
| E3 | SDK completo (download/verify/apply, slots, rollback 1-crash, notifyAppReady, eventos, deviceId) + config plugin Expo + codemods bare RN + doctor | E1, E2 |
| E4 | CLI: login/init/fingerprint/publish/releases/doctor | E2 |
| E5 | Telemetria (devices upsert, release_stats, /events) + Dashboard completo | E2 |
| E6 | Operação: promote, pause/resume/disable, rollback remoto, rollout, mandatory (server+CLI+dashboard) | E2–E5 |
| E7 | MCP: tools em shared + transporte stdio (`ota mcp`) + rota `/mcp` (Streamable HTTP) + OAuth 2.1/PKCE/DCR | E4, E6 |
| E8 | Preview: token assinado, deep link handler pinned, QR (dashboard + CLI), deep link autoconfig | E3, E6 |
| E9 | Targets Supabase (Edge Function, `init --provider supabase`) e Cloudflare (Workers, Hyperdrive, R2) + `ota console` | E2 (adapters prontos) |
| E10 | Modo hosted: orgs/membership no fluxo (schema já nasce multi-tenant em E2), signup + verificação de e-mail, Stripe (checkout/portal/webhooks/trial), quotas + usage, telas de org/billing no dashboard | E2, E5, E7 |
| E11 | Matriz de validação (§4) no app exemplo, nos três targets + fluxo hosted (signup → checkout → publish → MCP remoto via OAuth) | tudo |

## 3. Riscos técnicos e mitigação

| Risco | Por quê dói | Mitigação |
|---|---|---|
| **Injeção do boot path** (AppDelegate/MainApplication mudam entre versões de RN/Expo) | quebra silenciosa a cada SDK novo | abordagem do config plugin do hot-updater (battle-tested); codemods bare com marcadores de região idempotentes; matriz explícita de versões suportadas; E2E de prebuild no CI |
| **Old + New Arch simultâneos** (bridge `ReactNativeHost` vs bridgeless `ReactHost`) | dois caminhos de injeção e de teste por plataforma | detecção da variante no plugin/codemod; `ota doctor` reporta o caminho ativo; harness bare RN 0.73 (old) + Expo atual (new) no CI |
| **Resolução de assets offline** | telas sem imagem em produção | E1 é exatamente esse spike, antes de tudo |
| **Detecção de crash** (falso positivo: usuário mata o app antes do ready) | rollback indevido | `notifyAppReady` no primeiro frame (janela mínima); flag só conta como falha se o processo morreu sem `ready` |
| **Coexistência com expo-updates** | dois donos do bundle | plugin/codemod falha com instrução de remoção; `ota doctor` confere |
| **Fingerprint drift** | update recusado ou aceito errado | `fingerprint.json` commitado + `ota fingerprint --check` no CI |
| ~~Dialeto duplo (pg + sqlite/D1)~~ **eliminado** | seria matriz de teste ×2 sem ganho de usuário | decisão de implementação (28/08): Postgres nos três targets, Cloudflare via Hyperdrive. A camada de repositório continua sendo a única que fala Drizzle, então D1 pode entrar depois sem tocar os serviços |
| **Limites de edge function** (tamanho de request, CPU) | publish/telemetria falham no Supabase/CF | upload direto ao storage (nunca via função); handlers curtos; batch de eventos pequeno |
| Server é ponto único de assinatura | comprometimento = updates maliciosos | master key só via secrets do provider; superfície mínima; rate limit |
| **OAuth server próprio** (authorize/token/DCR) | superfície de segurança nova; bug = tokens indevidos | seguir MCP auth spec à risca (PKCE obrigatório, redirect URI exato, tokens curtos + refresh); testes de fluxo negativos; sem client secrets implícitos |
| **Webhooks Stripe** | evento duplicado/perdido = estado de billing errado | idempotência por event id (`stripe_events`), reconciliação diária via API do Stripe, `subscriptions` como espelho e não fonte |

## 4. Matriz de validação

- Android físico + emulador (API 24 e atual) · iPhone físico + simulador (iOS 15.1 e atual) · Hermes · **New Arch (Expo atual) e Old Arch (bare RN 0.73)** · Expo CNG **e** bare RN. Ambiente local confirmado pronto (Xcode + Android Studio).
- Cenários: update feliz · mandatory · release quebrada (throw no boot) → rollback automático → contadores certos · disable remoto → downgrade · rollout 10% (bucketing com N devices simulados) · preview QR (token válido/expirado/de outro projeto) · avião no meio do download · zip corrompido (hash falha) · assinatura inválida · canal trocado em runtime.
- Nos **três providers**: publish → update → rollback ponta a ponta.
- Carga: script simulando 10k devices (check + eventos) → throttle e contadores conferidos.

## 5. Kickoff

1. E0 + E1 (spike) — de-riscam o projeto inteiro.
2. Daí em diante, etapas na ordem; cada uma termina com o app exemplo exercitando a entrega.
