-- Trava para uma resposta por vez em cada chamado.
--
-- Cliente que manda foto e texto no mesmo segundo gera dois webhooks
-- simultaneos. Os dois processam o mesmo chamado, os dois diagnosticam, e o
-- cliente recebe a mesma orientacao duas vezes -- as vezes com pequenas
-- diferencas de redacao, o que fica pior ainda: parece que o suporte esta
-- confuso.
--
-- Checar "ja respondi?" em JavaScript nao resolve, porque entre a leitura e a
-- escrita cabe o outro processo inteiro. A exclusao tem que acontecer no
-- banco, num UPDATE condicional: quem consegue gravar responde, quem nao
-- consegue desiste.
--
-- O prazo curto (nao um booleano) evita que uma falha no meio do caminho
-- deixe o chamado travado para sempre.

alter table public.whatsapp_atendimentos
  add column if not exists respondendo_ate timestamptz;

comment on column public.whatsapp_atendimentos.respondendo_ate is
  'Enquanto estiver no futuro, outro processo esta preparando resposta para este chamado. Expira sozinho.';

create index if not exists idx_atend_respondendo
  on public.whatsapp_atendimentos (respondendo_ate)
  where respondendo_ate is not null;
