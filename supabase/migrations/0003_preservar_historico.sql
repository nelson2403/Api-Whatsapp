-- Remover um grupo nao pode destruir historico de atendimento.
--
-- Como estava: whatsapp_mensagens.grupo_id apagava em cascata junto com o
-- grupo. Na pratica isso significava que tirar um grupo da lista -- uma acao
-- de configuracao, que a interface apresenta como reversivel -- apagava toda
-- a conversa registrada dele.
--
-- Pior: era inconsistente. O atendimento sobrevivia (grupo_id vira null por
-- ON DELETE SET NULL) mas ficava sem nenhuma mensagem, entao a tela mostrava
-- um chamado vazio e sem origem identificavel.
--
-- Agora as duas pontas usam SET NULL: o grupo sai da lista, o historico fica.

alter table public.whatsapp_mensagens
  drop constraint if exists whatsapp_mensagens_grupo_id_fkey;

alter table public.whatsapp_mensagens
  add constraint whatsapp_mensagens_grupo_id_fkey
  foreign key (grupo_id)
  references public.whatsapp_grupos(id)
  on delete set null;
