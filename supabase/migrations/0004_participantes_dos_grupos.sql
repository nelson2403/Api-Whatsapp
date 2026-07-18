-- Quem participa dos grupos de suporte.
--
-- Motivo: a mensagem de "fale no grupo" estava indo para qualquer pessoa que
-- mandasse mensagem no privado -- parente, cliente de outro assunto, numero
-- desconhecido. Isso e invasivo e nao tem nada a ver com suporte.
--
-- A regra correta: so quem participa de um grupo ATIVO interage com a
-- ferramenta pelo privado. Sem grupo ativo, ninguem.

create table if not exists public.whatsapp_grupo_participantes (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.whatsapp_grupos(id) on delete cascade,

  numero        text not null,
  nome          text,
  admin         boolean not null default false,

  -- Sufixos gerados pelo banco para comparar telefone sem depender do formato
  -- de entrada. Mesma logica de telefonesBatem() no codigo: nunca compare
  -- telefone por igualdade exata, porque DDI e o 9o digito aparecem e somem.
  sufixo11      text generated always as (right(regexp_replace(numero, '\D', '', 'g'), 11)) stored,
  sufixo10      text generated always as (right(regexp_replace(numero, '\D', '', 'g'), 10)) stored,

  atualizado_em timestamptz not null default now(),

  unique (grupo_id, numero)
);

create index if not exists idx_participantes_sufixo11 on public.whatsapp_grupo_participantes (sufixo11);
create index if not exists idx_participantes_sufixo10 on public.whatsapp_grupo_participantes (sufixo10);
create index if not exists idx_participantes_grupo    on public.whatsapp_grupo_participantes (grupo_id);

alter table public.whatsapp_grupo_participantes enable row level security;

create policy participantes_leitura on public.whatsapp_grupo_participantes
  for select to authenticated using (true);
create policy participantes_escrita on public.whatsapp_grupo_participantes
  for all to authenticated using (public.eh_admin()) with check (public.eh_admin());

-- ---------------------------------------------------------------------------
-- O numero pertence a algum grupo ATIVO?
--
-- Uma funcao em vez de consulta na aplicacao porque o webhook chama isso a
-- cada mensagem privada, e resolver o join com indice no banco e muito mais
-- barato do que trazer milhares de participantes para comparar em JavaScript.
-- ---------------------------------------------------------------------------
create or replace function public.numero_em_grupo_ativo(num text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.whatsapp_grupo_participantes p
    join public.whatsapp_grupos g on g.id = p.grupo_id
    where g.ativo
      and (
        p.sufixo11 = right(regexp_replace(num, '\D', '', 'g'), 11)
        -- Fallback para fixo/numero sem o 9o digito. Nao descemos para 8
        -- digitos: sem o DDD, numeros de estados diferentes colidiriam.
        or p.sufixo10 = right(regexp_replace(num, '\D', '', 'g'), 10)
      )
  );
$$;

grant execute on function public.numero_em_grupo_ativo(text) to authenticated, service_role;

-- Quantos participantes cada grupo tem sincronizados, para a tela mostrar.
create or replace view public.whatsapp_grupos_com_participantes as
select
  g.*,
  count(p.id)          as total_participantes,
  max(p.atualizado_em) as participantes_atualizados_em
from public.whatsapp_grupos g
left join public.whatsapp_grupo_participantes p on p.grupo_id = g.id
group by g.id;
