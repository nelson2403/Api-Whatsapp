-- Midia recebida, imagens de exemplo na base e prioridade vinda do conhecimento.

-- ---------------------------------------------------------------------------
-- 1. Midia das mensagens
--
-- A URL que o Z-API manda aponta para um storage temporario e EXPIRA. Guardar
-- so ela significa que, dias depois, o atendente abre um chamado antigo e ve
-- imagem quebrada -- justamente quando o historico importa mais.
-- Por isso o arquivo e rehospedado no Storage do Supabase no recebimento, e
-- a URL original fica so como registro do que chegou.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_mensagens
  add column if not exists midia_url      text,
  add column if not exists midia_tipo     text,
  add column if not exists midia_nome     text,
  add column if not exists midia_original text;

alter table public.whatsapp_mensagens
  drop constraint if exists whatsapp_mensagens_tipo_check;

alter table public.whatsapp_mensagens
  add constraint whatsapp_mensagens_tipo_check
  check (tipo in ('texto', 'imagem', 'video', 'audio', 'documento', 'outro'));

-- ---------------------------------------------------------------------------
-- 2. Base de conhecimento: imagens de exemplo e urgencia
--
-- As imagens de exemplo servem a dois publicos: o atendente, que reconhece o
-- caso de relance, e o modelo de visao, que compara com o print enviado pelo
-- cliente.
--
-- A urgencia sai daqui e nao de um palpite sobre o texto: quem sabe que
-- "bomba parada" para a operacao e quem escreveu o caso, nao o modelo.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_base_conhecimento
  add column if not exists imagens         text[] not null default '{}',
  add column if not exists urgencia_padrao text not null default 'normal'
    check (urgencia_padrao in ('baixa', 'normal', 'alta'));

-- ---------------------------------------------------------------------------
-- 3. Atendimento: como a prioridade foi decidida
--
-- Sem isto, "por que este chamado esta como urgente?" nao tem resposta -- e
-- prioridade que ninguem entende e prioridade que ninguem respeita.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_atendimentos
  add column if not exists motivo_prioridade text,
  add column if not exists entrou_na_fila_em timestamptz;

-- Fila de espera: quem aguarda atendente humano, na ordem certa.
create or replace view public.whatsapp_fila_espera as
select
  a.*,
  g.nome as grupo_nome,
  extract(epoch from (now() - coalesce(a.entrou_na_fila_em, a.escalado_em, a.created_at))) as segundos_esperando,
  row_number() over (
    order by
      case a.prioridade when 'alta' then 0 when 'normal' then 1 else 2 end,
      coalesce(a.entrou_na_fila_em, a.escalado_em, a.created_at)
  ) as posicao
from public.whatsapp_atendimentos a
left join public.whatsapp_grupos g on g.id = a.grupo_id
where a.usuario_id is null
  and a.ia_escalado
  and a.status in ('aberto', 'em_andamento');

-- ---------------------------------------------------------------------------
-- 4. Storage das midias
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('midias', 'midias', true, 26214400) -- 25 MB
on conflict (id) do update set public = true, file_size_limit = 26214400;

-- Leitura publica: as URLs sao longas e nao advinhaveis, e o painel precisa
-- exibir a imagem direto no <img>.
drop policy if exists "midias leitura publica" on storage.objects;
create policy "midias leitura publica" on storage.objects
  for select using (bucket_id = 'midias');

-- Upload pelo atendente (imagens de exemplo da base de conhecimento).
-- O webhook usa a chave de servico e nao passa por estas policies.
drop policy if exists "midias upload autenticado" on storage.objects;
create policy "midias upload autenticado" on storage.objects
  for insert to authenticated with check (bucket_id = 'midias');

drop policy if exists "midias update autenticado" on storage.objects;
create policy "midias update autenticado" on storage.objects
  for update to authenticated using (bucket_id = 'midias');

drop policy if exists "midias delete autenticado" on storage.objects;
create policy "midias delete autenticado" on storage.objects
  for delete to authenticated using (bucket_id = 'midias');
