-- Contadores de eficacia da base de conhecimento.
--
-- Sao RPCs em vez de UPDATE direto pelo app porque o fluxo pode processar
-- varias mensagens ao mesmo tempo: `vezes_usado = vezes_usado + 1` dentro do
-- banco e atomico, enquanto ler-somar-gravar pela aplicacao perde contagem.

create or replace function public.incrementar_uso_caso(caso uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.whatsapp_base_conhecimento
  set vezes_usado = vezes_usado + 1
  where id = caso;
$$;

create or replace function public.incrementar_acerto_caso(caso uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.whatsapp_base_conhecimento
  set vezes_resolveu = vezes_resolveu + 1
  where id = caso;
$$;

grant execute on function public.incrementar_uso_caso(uuid)    to authenticated, service_role;
grant execute on function public.incrementar_acerto_caso(uuid) to authenticated, service_role;

-- Taxa de acerto por caso: mostra quais casos da base realmente resolvem e
-- quais so ocupam espaco no prompt.
create or replace view public.whatsapp_eficacia_casos as
select
  id,
  titulo,
  categoria,
  ativo,
  vezes_usado,
  vezes_resolveu,
  case
    when vezes_usado = 0 then null
    else round((vezes_resolveu::numeric / vezes_usado) * 100, 1)
  end as taxa_acerto_pct
from public.whatsapp_base_conhecimento
order by vezes_usado desc;
