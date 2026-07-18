-- ===========================================================================
-- Central de Suporte WhatsApp -- schema inicial
--
-- Diferenca principal em relacao a ferramenta anterior: o eixo do sistema
-- deixa de ser "um contato = uma conversa" e passa a ser "um chamado dentro
-- de um grupo". Num grupo varias pessoas falam ao mesmo tempo, entao um
-- atendimento e identificado pelo par (grupo, participante), nao pelo chat.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- updated_at automatico
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Perfis de usuario
--    Espelha auth.users e carrega o papel. Existe para que as tabelas de
--    configuracao possam ser escritas so por admin, em vez do modelo antigo
--    de "qualquer autenticado edita tudo".
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_perfis (
  id          uuid primary key references auth.users(id) on delete cascade,
  nome        text not null default '',
  email       text,
  -- telefone pessoal do atendente, usado para o alerta de escalonamento
  telefone    text,
  papel       text not null default 'atendente'
              check (papel in ('admin', 'atendente')),
  ativo       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_perfis_updated
  before update on public.whatsapp_perfis
  for each row execute function public.tg_set_updated_at();

-- Usada nas policies. SECURITY DEFINER para nao recursar na RLS da propria
-- tabela de perfis quando a policy consultar o papel.
create or replace function public.eh_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.whatsapp_perfis
    where id = auth.uid() and papel = 'admin' and ativo
  );
$$;

-- Cria o perfil junto com o usuario. O primeiro usuario do sistema vira admin
-- automaticamente -- senao ninguem conseguiria configurar nada.
create or replace function public.tg_novo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  primeiro boolean;
begin
  select not exists (select 1 from public.whatsapp_perfis) into primeiro;

  insert into public.whatsapp_perfis (id, nome, email, papel)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome', split_part(new.email, '@', 1)),
    new.email,
    case when primeiro then 'admin' else 'atendente' end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_auth_novo_usuario on auth.users;
create trigger trg_auth_novo_usuario
  after insert on auth.users
  for each row execute function public.tg_novo_usuario();

-- ---------------------------------------------------------------------------
-- 2. Configuracao global (singleton, sempre id = 1)
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_config (
  id                        smallint primary key default 1 check (id = 1),

  -- Interruptor geral: desliga TODA a automacao de uma vez. As mensagens
  -- continuam sendo gravadas e aparecendo no painel.
  bot_ativo                 boolean not null default true,

  -- Liga a camada de resposta por IA especificamente.
  ia_ativa                  boolean not null default true,

  -- Liga o classificador que decide se uma mensagem de grupo e um chamado.
  -- Desligado, toda mensagem de participante vira chamado.
  ia_classificacao_ativa    boolean not null default true,

  -- Quantas respostas automaticas a IA pode tentar num mesmo chamado antes
  -- de desistir e chamar um humano.
  max_tentativas_ia         smallint not null default 2 check (max_tentativas_ia between 1 and 5),

  -- Escalonamento -----------------------------------------------------------
  alerta_ativo              boolean not null default true,
  -- Numero pessoal que recebe o alerta de escalonamento, com DDI. Ex: 5527999999999
  numero_alerta             text,

  -- Mensagens privadas ------------------------------------------------------
  -- Todo o suporte e centralizado nos grupos. Quem chamar no privado recebe
  -- esta mensagem em vez de abrir chamado.
  redirecionar_privado      boolean not null default true,
  mensagem_privado          text not null default
    'Ola! Para agilizar o atendimento, todas as solicitacoes de suporte devem ser enviadas *no grupo de suporte*. Assim toda a equipe consegue acompanhar e responder mais rapido. Obrigado!',
  -- Nao repete o aviso para o mesmo numero antes disso (evita spam).
  privado_aviso_horas       smallint not null default 12,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create trigger trg_config_updated
  before update on public.whatsapp_config
  for each row execute function public.tg_set_updated_at();

insert into public.whatsapp_config (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. Grupos de suporte
--    Um grupo so e atendido se estiver cadastrado aqui e ativo. Grupo
--    desconhecido e ignorado -- assim ninguem adiciona o numero num grupo
--    aleatorio e o bot sai respondendo.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_grupos (
  id                    uuid primary key default gen_random_uuid(),

  -- Identificador do grupo como o Z-API manda no campo `phone`.
  -- Ex: 120363000000000000-group
  grupo_id              text not null unique,
  nome                  text not null,
  descricao             text,
  ativo                 boolean not null default true,

  -- Janela de atendimento humano ------------------------------------------
  atendimento_24h       boolean not null default false,
  horario_inicio        time not null default '06:00',
  horario_fim           time not null default '22:00',
  -- 0 = domingo ... 6 = sabado (mesma convencao de Date.getDay() em JS)
  dias_semana           smallint[] not null default '{0,1,2,3,4,5,6}',
  timezone              text not null default 'America/Sao_Paulo',

  -- Enviada quando chega chamado fora da janela. {{horario_inicio}} e
  -- {{horario_fim}} sao substituidos no envio.
  mensagem_fora_horario text not null default
    'Recebemos sua mensagem! No momento estamos fora do horario de atendimento ({{horario_inicio}} as {{horario_fim}}). Vou tentar te ajudar por aqui agora mesmo, e se precisar de um atendente ele retorna a partir das {{horario_inicio}}.',

  -- Anti-flood: minutos minimos entre duas respostas automaticas para o
  -- MESMO participante no grupo. 0 desliga o limite.
  anti_flood_minutos    smallint not null default 3,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger trg_grupos_updated
  before update on public.whatsapp_grupos
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Atendimentos (chamados)
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_atendimentos (
  id                  uuid primary key default gen_random_uuid(),

  origem              text not null default 'grupo'
                      check (origem in ('grupo', 'privado')),
  grupo_id            uuid references public.whatsapp_grupos(id) on delete set null,

  -- Quem abriu o chamado. Em grupo e o participante, nao o grupo.
  contato_numero      text not null,
  contato_nome        text,

  status              text not null default 'aberto'
                      check (status in ('aberto', 'em_andamento', 'aguardando_cliente', 'resolvido', 'encerrado')),
  categoria           text,
  prioridade          text not null default 'normal'
                      check (prioridade in ('baixa', 'normal', 'alta')),

  -- Atendente que assumiu. Enquanto for null o bot pode responder; assim que
  -- alguem assume, o bot cala a boca nesse chamado.
  usuario_id          uuid references public.whatsapp_perfis(id) on delete set null,
  assumido_em         timestamptz,

  -- IA ---------------------------------------------------------------------
  ia_tentativas       smallint not null default 0,
  ia_escalado         boolean not null default false,
  escalado_em         timestamptz,
  motivo_escalonamento text,

  -- Caso da base que a IA usou por ultimo -- alimenta a metrica de eficacia.
  caso_sugerido_id    uuid,

  resolvido_por       text check (resolvido_por in ('ia', 'humano')),
  resolvido_em        timestamptz,

  primeira_resposta_em  timestamptz,
  ultima_mensagem_em    timestamptz not null default now(),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger trg_atendimentos_updated
  before update on public.whatsapp_atendimentos
  for each row execute function public.tg_set_updated_at();

create index if not exists idx_atend_status      on public.whatsapp_atendimentos (status, ultima_mensagem_em desc);
create index if not exists idx_atend_grupo       on public.whatsapp_atendimentos (grupo_id);
create index if not exists idx_atend_usuario     on public.whatsapp_atendimentos (usuario_id);
create index if not exists idx_atend_escalado    on public.whatsapp_atendimentos (ia_escalado) where ia_escalado;

-- Um participante so pode ter UM chamado vivo por grupo. E o que faz a
-- segunda mensagem dele entrar no chamado existente em vez de abrir outro.
create unique index if not exists uq_atend_vivo
  on public.whatsapp_atendimentos (coalesce(grupo_id, '00000000-0000-0000-0000-000000000000'::uuid), contato_numero)
  where status in ('aberto', 'em_andamento', 'aguardando_cliente');

-- ---------------------------------------------------------------------------
-- 5. Mensagens
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_mensagens (
  id                uuid primary key default gen_random_uuid(),
  atendimento_id    uuid references public.whatsapp_atendimentos(id) on delete cascade,

  -- Mensagens de grupo que o classificador julgou nao ser chamado ficam com
  -- atendimento_id null: gravadas para auditoria, invisiveis no painel.
  grupo_id          uuid references public.whatsapp_grupos(id) on delete cascade,

  direcao           text not null check (direcao in ('recebida', 'enviada')),
  tipo              text not null default 'texto'
                    check (tipo in ('texto', 'imagem', 'audio', 'documento', 'outro')),
  conteudo          text,

  -- Em grupo, quem realmente falou (o `phone` do payload e o grupo).
  remetente_numero  text,
  remetente_nome    text,

  -- Idempotencia: o Z-API reenvia o mesmo evento em caso de falha de entrega.
  zapi_message_id   text unique,

  gerado_por_ia     boolean not null default false,
  enviado_por       uuid references public.whatsapp_perfis(id) on delete set null,

  -- Payload cru, para auditoria e para ler a URL da imagem.
  raw               jsonb,

  created_at        timestamptz not null default now()
);

create index if not exists idx_msg_atendimento on public.whatsapp_mensagens (atendimento_id, created_at);
create index if not exists idx_msg_grupo       on public.whatsapp_mensagens (grupo_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 6. Base de conhecimento -- os casos de suporte
--    Esta e a fonte que a IA consulta. Ela nao pode inventar procedimento:
--    ou responde a partir de um caso daqui, ou escala.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_base_conhecimento (
  id              uuid primary key default gen_random_uuid(),

  titulo          text not null,
  categoria       text,

  -- Como o cliente descreve o problema, em linguagem de cliente. Alimenta
  -- tanto o pre-filtro por texto quanto o prompt da IA.
  -- Ex: {'bomba nao liga', 'bomba travada', 'nao ta bombeando'}
  sintomas        text[] not null default '{}',

  causa           text,

  -- Passo-a-passo ordenado. Array de strings; a IA reproduz na ordem.
  passos          text[] not null default '{}',

  -- Fechamento / observacao final enviada depois dos passos.
  observacao      text,

  -- Casos que nunca devem ser tentados pela IA (ex: precisa de acesso fisico,
  -- envolve dinheiro, exige decisao). Bate o caso e escala direto.
  escalar_direto  boolean not null default false,

  -- Desempata quando mais de um caso combina. Maior vence.
  prioridade      smallint not null default 0,
  ativo           boolean not null default true,

  -- Metrica de eficacia, atualizada pelo fluxo.
  vezes_usado     integer not null default 0,
  vezes_resolveu  integer not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger trg_conhecimento_updated
  before update on public.whatsapp_base_conhecimento
  for each row execute function public.tg_set_updated_at();

create index if not exists idx_kb_ativo    on public.whatsapp_base_conhecimento (ativo, prioridade desc);
create index if not exists idx_kb_sintomas on public.whatsapp_base_conhecimento using gin (sintomas);

alter table public.whatsapp_atendimentos
  add constraint fk_atend_caso
  foreign key (caso_sugerido_id)
  references public.whatsapp_base_conhecimento(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 7. Conhecimento aprendido -- casos resolvidos por humano
--    Populado pelo modal de encerramento. Vira contexto extra pra IA e,
--    quando promovido, vira um caso oficial na base acima.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_conhecimento_aprendido (
  id              uuid primary key default gen_random_uuid(),
  atendimento_id  uuid references public.whatsapp_atendimentos(id) on delete set null,
  problema        text not null,
  causa           text,
  solucao         text not null,
  categoria       text,
  registrado_por  uuid references public.whatsapp_perfis(id) on delete set null,
  -- Marcado quando o caso e promovido para whatsapp_base_conhecimento.
  promovido       boolean not null default false,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 8. Numeros sem resposta automatica
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_numeros_ignorados (
  id          uuid primary key default gen_random_uuid(),
  numero      text not null unique,
  observacao  text,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9. Respostas rapidas do atendente
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_respostas_rapidas (
  id          uuid primary key default gen_random_uuid(),
  titulo      text not null,
  texto       text not null,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 10. Alertas de escalonamento
--     Cada linha e um chamado que precisa de humano. O painel escuta esta
--     tabela via Realtime e dispara o alarme sonoro; `lido_em` para o alarme.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_alertas (
  id              uuid primary key default gen_random_uuid(),
  atendimento_id  uuid not null references public.whatsapp_atendimentos(id) on delete cascade,
  titulo          text not null,
  detalhe         text,
  urgencia        text not null default 'normal'
                  check (urgencia in ('normal', 'alta')),

  -- Alerta gerado fora do horario fica pendente ate a janela abrir.
  agendado_para   timestamptz not null default now(),

  whatsapp_enviado_em timestamptz,
  lido_em         timestamptz,
  lido_por        uuid references public.whatsapp_perfis(id) on delete set null,

  created_at      timestamptz not null default now()
);

create index if not exists idx_alertas_pendentes
  on public.whatsapp_alertas (agendado_para)
  where lido_em is null;

-- ---------------------------------------------------------------------------
-- 11. Controle de avisos no privado (rate limit da mensagem "fale no grupo")
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_avisos_privado (
  numero       text primary key,
  avisado_em   timestamptz not null default now(),
  vezes        integer not null default 1
);

-- ---------------------------------------------------------------------------
-- Metricas
-- ---------------------------------------------------------------------------
create or replace view public.whatsapp_metricas as
select
  count(*)                                                          as total,
  count(*) filter (where status in ('aberto','em_andamento'))       as abertos,
  count(*) filter (where ia_escalado and usuario_id is null)        as aguardando_atendente,
  count(*) filter (where resolvido_por = 'ia')                      as resolvidos_ia,
  count(*) filter (where resolvido_por = 'humano')                  as resolvidos_humano,
  avg(extract(epoch from (primeira_resposta_em - created_at)))
    filter (where primeira_resposta_em is not null)                 as segundos_ate_primeira_resposta,
  avg(extract(epoch from (resolvido_em - created_at)))
    filter (where resolvido_em is not null)                         as segundos_ate_resolucao
from public.whatsapp_atendimentos
where created_at > now() - interval '30 days';

-- ===========================================================================
-- RLS
--
-- Modelo: qualquer atendente autenticado le e opera os atendimentos (e uma
-- caixa compartilhada, essa parte e intencional). Ja as tabelas de
-- configuracao -- grupos, base de conhecimento, config global -- sao
-- somente-leitura para atendente e escrita apenas para admin.
--
-- O webhook nao usa nenhuma destas policies: roda com a chave service_role,
-- que ignora RLS, porque nao existe sessao de usuario numa chamada do Z-API.
-- ===========================================================================

alter table public.whatsapp_perfis                 enable row level security;
alter table public.whatsapp_config                 enable row level security;
alter table public.whatsapp_grupos                 enable row level security;
alter table public.whatsapp_atendimentos           enable row level security;
alter table public.whatsapp_mensagens              enable row level security;
alter table public.whatsapp_base_conhecimento      enable row level security;
alter table public.whatsapp_conhecimento_aprendido enable row level security;
alter table public.whatsapp_numeros_ignorados      enable row level security;
alter table public.whatsapp_respostas_rapidas      enable row level security;
alter table public.whatsapp_alertas                enable row level security;
alter table public.whatsapp_avisos_privado         enable row level security;

-- Perfis: cada um le todos (pra mostrar nome do atendente), edita so o seu;
-- admin edita qualquer um.
create policy perfis_leitura on public.whatsapp_perfis
  for select to authenticated using (true);
create policy perfis_self on public.whatsapp_perfis
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy perfis_admin on public.whatsapp_perfis
  for all to authenticated using (public.eh_admin()) with check (public.eh_admin());

-- Operacao diaria: aberto para qualquer atendente autenticado.
create policy atendimentos_tudo on public.whatsapp_atendimentos
  for all to authenticated using (true) with check (true);
create policy mensagens_tudo on public.whatsapp_mensagens
  for all to authenticated using (true) with check (true);
create policy aprendido_tudo on public.whatsapp_conhecimento_aprendido
  for all to authenticated using (true) with check (true);
create policy alertas_tudo on public.whatsapp_alertas
  for all to authenticated using (true) with check (true);
create policy rapidas_tudo on public.whatsapp_respostas_rapidas
  for all to authenticated using (true) with check (true);

-- Configuracao: leitura para todos, escrita so admin.
create policy config_leitura on public.whatsapp_config
  for select to authenticated using (true);
create policy config_escrita on public.whatsapp_config
  for update to authenticated using (public.eh_admin()) with check (public.eh_admin());

create policy grupos_leitura on public.whatsapp_grupos
  for select to authenticated using (true);
create policy grupos_escrita on public.whatsapp_grupos
  for all to authenticated using (public.eh_admin()) with check (public.eh_admin());

create policy kb_leitura on public.whatsapp_base_conhecimento
  for select to authenticated using (true);
create policy kb_escrita on public.whatsapp_base_conhecimento
  for all to authenticated using (public.eh_admin()) with check (public.eh_admin());

create policy ignorados_leitura on public.whatsapp_numeros_ignorados
  for select to authenticated using (true);
create policy ignorados_escrita on public.whatsapp_numeros_ignorados
  for all to authenticated using (public.eh_admin()) with check (public.eh_admin());

create policy avisos_leitura on public.whatsapp_avisos_privado
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Realtime: o painel escuta estas tabelas.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.whatsapp_atendimentos;
alter publication supabase_realtime add table public.whatsapp_mensagens;
alter publication supabase_realtime add table public.whatsapp_alertas;
