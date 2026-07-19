-- Transcricao do que a IA leu na imagem.
--
-- Guardar isso resolve dois problemas de uma vez:
--
--   1. O pre-filtro da base recebia so "[imagem enviada]" e escolhia os casos
--      candidatos praticamente no escuro. O que identificava o problema --
--      codigo de erro, IP, porta -- estava dentro da foto, invisivel para a
--      busca. Lendo antes, o texto extraido alimenta o filtro.
--
--   2. O atendente precisava abrir e ampliar cada print para saber do que se
--      tratava. Com a transcricao ao lado da imagem, ele le de relance -- e
--      consegue buscar por texto depois.

alter table public.whatsapp_mensagens
  add column if not exists leitura_ia text;

comment on column public.whatsapp_mensagens.leitura_ia is
  'Transcricao e dados extraidos da imagem pelo modelo de visao. Nulo quando nao ha imagem ou a leitura falhou.';
