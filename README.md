# Central de Suporte WhatsApp

Atendimento em grupos de suporte no WhatsApp, com diagnóstico automático a
partir de uma base de conhecimento própria e escalonamento sonoro para o
atendente quando a automação não resolve.

**Stack:** Next.js 15 (App Router) · TypeScript · Supabase (Postgres + Auth +
RLS + Realtime) · Z-API · Groq.

---

## O que ele faz

O eixo do sistema é o **grupo de suporte**, não a conversa individual. Num
grupo várias pessoas falam ao mesmo tempo, então cada chamado é identificado
pelo par *(grupo, participante)* — duas pessoas relatando problemas diferentes
no mesmo grupo geram dois chamados separados.

Fluxo de uma mensagem recebida:

1. Mensagem chega no grupo e é **sempre gravada**, aconteça o que acontecer
   depois. Essa é a garantia central: o atendente enxerga tudo no painel mesmo
   quando a automação decide ficar calada.
2. A IA **classifica**: é um chamado, conversa solta ("bom dia", "valeu"), uma
   confirmação de que resolveu, ou um "não funcionou"? Conversa solta não vira
   chamado e não polui o painel.
3. Sendo chamado, a IA busca na **base de conhecimento** um caso cujos sintomas
   correspondam ao relato.
4. Achou → responde **no grupo**, citando a mensagem e mencionando quem pediu,
   com o passo-a-passo do caso.
5. Não achou, ou o cliente disse que não resolveu, ou o caso está marcado como
   "sempre humano" → **escala**: alarme sonoro no painel + mensagem no seu
   WhatsApp pessoal.

### A IA não improvisa

Ela não tem conhecimento próprio sobre a sua operação. Duas travas no código
(não no prompt, que se contorna):

- **Sem caso correspondente na base, ela não responde.** Escala.
- **Qualquer falha** (API fora, JSON inválido, timeout) escala.

Se o modelo citar um caso que não existe entre os candidatos, a resposta é
descartada — é o sinal de que ela inventou em vez de consultar.

O pior resultado possível é o cliente receber um procedimento inventado. O
segundo pior é ficar sem resposta *e* sem ninguém avisado. Escalar resolve os
dois.

---

## Instalação

### 1. Banco de dados (Supabase)

No **SQL Editor** do projeto, rode na ordem:

1. `supabase/migrations/0001_schema_inicial.sql`
2. `supabase/migrations/0002_funcoes_metricas.sql`
3. *(opcional)* `supabase/seed.sql` — casos de exemplo, para ver funcionando.
   Apague depois: casos genéricos fazem a IA responder besteira com confiança.

Depois crie seu usuário em **Authentication → Users → Add user**. O primeiro
usuário criado vira **admin** automaticamente (trigger `tg_novo_usuario`).

### 2. Variáveis de ambiente

Copie `.env.example` para `.env.local` e preencha:

| Variável | Onde conseguir |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | idem (pública por natureza) |
| `SUPABASE_SERVICE_ROLE_KEY` | idem — **secreta, ignora todo o RLS** |
| `ZAPI_INSTANCE_ID` / `ZAPI_TOKEN` | painel Z-API → Instâncias Web |
| `ZAPI_CLIENT_TOKEN` | painel Z-API → **Segurança** → token da conta |
| `ZAPI_WEBHOOK_SECRET` | você gera: `openssl rand -hex 24` |
| `GROQ_API_KEY` | https://console.groq.com/keys (tem plano gratuito) |
| `CRON_SECRET` | você gera: `openssl rand -hex 24` |

### 3. Rodar

```bash
npm install
npm run dev
```

### 4. Configurar o webhook no Z-API

No painel Z-API → **Webhooks e configurações gerais**:

- **Ao receber:** `https://SEU-DOMINIO/api/webhooks/zapi/SEU_ZAPI_WEBHOOK_SECRET`
- **"Ignorar mensagens de grupos"** → precisa ficar **DESLIGADO**. É por aí que
  todo o suporte entra.
- **"Notificar as enviadas por mim também"** → pode deixar desligado.

Para conferir se acertou, abra a mesma URL no navegador (GET). Deve responder
`{"ok": true}`. Se der 404, o segredo não confere.

### 5. Ativar os grupos

Adicione o número do WhatsApp aos grupos de suporte e mande qualquer mensagem
neles. Em segundos eles aparecem em **Configurações → Grupos de suporte**, já
**desativados** — de propósito: assim ninguém adiciona o número num grupo
qualquer e o bot sai respondendo. Ative os que você quer atender e ajuste o
horário (padrão 06:00–22:00, todos os dias).

### 6. Cadastrar os casos

Vá em **Base de conhecimento** e cadastre os problemas que a ferramenta deve
saber resolver. **Enquanto a base estiver vazia, todo chamado vai direto para
atendente humano** — que é o comportamento correto, mas não é o que você quer.

Como escrever um caso bom:

- **Sintomas** → do jeito que o cliente fala, não do jeito técnico. Uma
  variação por linha. `"não sai cupom"`, `"impressora travou"`, `"não tá
  imprimindo"`. Quanto mais variações, melhor o reconhecimento.
- **Passos** → um por linha, na ordem, em linguagem de quem está na ponta. A IA
  reproduz na ordem exata, sem pular nem improvisar.
- **"Sempre encaminhar para atendente"** → marque em casos que envolvem
  dinheiro, decisão ou acesso físico. A IA reconhece o problema mas não tenta
  resolver: chama você direto.

---

## Deploy na Vercel

1. Importe o repositório na Vercel.
2. Cole todas as variáveis de `.env.local` em **Settings → Environment
   Variables** (inclusive `SUPABASE_SERVICE_ROLE_KEY`).
3. Ajuste `NEXT_PUBLIC_APP_URL` para a URL final — ela entra no link das
   mensagens de alerta.
4. Atualize o webhook no Z-API para o domínio de produção.

O `vercel.json` já agenda o cron que despacha alertas represados fora do
horário, a cada 15 minutos.

---

## Alertas

Quando um chamado escala, dois canais disparam:

- **Painel:** alarme sonoro em loop (Web Audio API, sintetizado — não depende
  de arquivo de áudio) + notificação do sistema. Só para quando alguém clica em
  *"Estou atendendo"* ou assume o chamado.
- **WhatsApp:** mensagem para o número em **Configurações → Alerta de
  escalonamento**.

Alerta gerado **fora do horário** não some nem acorda ninguém: fica gravado com
`agendado_para` na próxima abertura da janela, e o cron despacha quando ela
abre.

> O navegador bloqueia áudio antes de qualquer clique na página. Se o alarme
> aparecer com o botão **"🔊 Ativar som"**, clique uma vez — depois disso ele
> toca sozinho pelo resto da sessão.

---

## Decisões de arquitetura

**A UI fala direto com o Supabase.** O RLS já governa quem lê e escreve o quê;
espelhar isso em rotas REST seria duplicar a regra em dois lugares. Só existem
rotas de servidor onde há segredo envolvido: envio pelo Z-API, status da
instância, webhook e cron.

**RLS em dois níveis.** Operação (chamados, mensagens, alertas) é caixa
compartilhada: qualquer atendente autenticado opera tudo. Configuração (grupos,
base de conhecimento, config global) é leitura para todos, escrita só para
`admin`.

**O webhook sempre devolve 200**, inclusive em erro interno. O Z-API reenvia
eventos que não receberam 200, e reprocessar significa mandar a mesma resposta
duas vezes para o cliente. Erro vai para o log, não para o status HTTP.

**Telefone nunca é comparado por igualdade**, sempre por sufixo de dígitos
(`telefonesBatem`). Número digitado à mão vem sem DDI, o do payload vem com —
comparar por igualdade falha em silêncio.

---

## Armadilhas conhecidas

Herdadas da versão anterior desta ferramenta, documentadas para não voltarem:

- **Middleware bloqueando o webhook.** Sem a rota na allowlist pública de
  `src/middleware.ts`, o Next redireciona a chamada do Z-API para o login e o
  handler **nunca executa** — sem gerar log nenhum. O sintoma é "não está
  chegando nada" quando na verdade está sendo barrado antes de chegar. Se o
  webhook parecer morto, olhe aqui primeiro.
- **Pareamento do Z-API cai sozinho** (celular sem bateria, WhatsApp Web
  deslogado, plano vencido) e, quando cai, nada mais chega — sem erro visível.
  O indicador no topo do painel confere isso de minuto em minuto.
- **URL de imagem do Z-API expira.** `raw.image.imageUrl` aponta para storage
  temporário. Imagens antigas param de carregar no painel. Rehospedar no
  recebimento é uma melhoria pendente.
- **Áudio não é transcrito.** Cai como `tipo='audio'` e escala direto para
  humano.

---

## Estrutura

```
src/
├── app/
│   ├── (painel)/              telas autenticadas (alarme vive no layout)
│   │   ├── atendimento/       inbox
│   │   ├── base-conhecimento/ cadastro dos casos
│   │   └── configuracoes/     grupos, horários, alertas, automação
│   ├── api/
│   │   ├── webhooks/zapi/[secret]/   entrada de mensagens (público)
│   │   ├── cron/alertas-pendentes/   despacha alertas represados
│   │   └── whatsapp/                 envio manual + status
│   └── login/
├── components/
│   ├── AlarmeEscalonamento.tsx   alarme sonoro via Realtime
│   ├── Inbox.tsx                 painel de atendimento
│   └── Nav.tsx
├── lib/
│   ├── supabase/     client (navegador) · server (sessão) · admin (webhook)
│   └── whatsapp/
│       ├── fluxo.ts      ← a cascata de atendimento, coração do sistema
│       ├── ia.ts         classificação + diagnóstico
│       ├── zapi.ts       cliente Z-API
│       ├── alertas.ts    escalonamento
│       ├── horario.ts    janela de atendimento por fuso
│       └── telefone.ts   normalização e comparação
└── middleware.ts
supabase/migrations/
```

O arquivo para ler primeiro é `src/lib/whatsapp/fluxo.ts` — o cabeçalho dele
lista a cascata inteira, passo a passo.

---

## Melhorias pendentes

- Rehospedar imagens antes do link do Z-API expirar
- Transcrição de áudio (Whisper) em vez de escalar direto
- Busca semântica (embeddings + pgvector) quando a base passar de ~200 casos —
  hoje o pré-filtro é por sobreposição de termos
- Múltiplas instâncias Z-API (hoje é um número, via env)
- Envio de mídia pelo atendente
- Painel de métricas (a view `whatsapp_metricas` já existe, falta a tela)
