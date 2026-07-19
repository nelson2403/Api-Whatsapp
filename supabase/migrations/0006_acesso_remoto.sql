-- Pedir o acesso remoto junto com o escalonamento.
--
-- Quando a IA desiste e chama um humano, o atendente normalmente vai precisar
-- entrar na maquina. Pedir o ID do AnyDesk so quando ele assume custa mais um
-- ciclo de ida e volta -- e o cliente pode ter saido de perto do computador.
-- Pedindo junto com o aviso de "vou chamar um atendente", o ID costuma estar
-- esperando quando o atendente abre o chamado.

-- ---------------------------------------------------------------------------
-- Configuracao global
-- ---------------------------------------------------------------------------
alter table public.whatsapp_config
  add column if not exists pedir_acesso_remoto boolean not null default true,
  add column if not exists mensagem_acesso_remoto text not null default
    'Para agilizar, ja me manda o *ID do AnyDesk* dessa maquina (aquele numero de 9 digitos que aparece na tela do programa). Assim o atendente ja entra direto quando assumir.';

-- ---------------------------------------------------------------------------
-- Por caso: nem todo problema comporta acesso remoto
--
-- Pedir AnyDesk para quem esta sem internet e pedir o impossivel -- o
-- programa depende justamente da conexao que caiu. O mesmo vale para
-- problema de impressora fisica, maquina que nao liga, etc.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_base_conhecimento
  add column if not exists pedir_acesso_remoto boolean not null default true;

-- Casos de rede/energia ja entram desmarcados: nesses o acesso remoto nao
-- funciona por definicao.
update public.whatsapp_base_conhecimento
set pedir_acesso_remoto = false
where categoria ilike any (array['%rede%', '%internet%', '%energia%'])
   or titulo ilike any (array['%internet%', '%sem conexao%', '%nao liga%']);

-- ---------------------------------------------------------------------------
-- Guarda o acesso informado pelo cliente
-- ---------------------------------------------------------------------------
alter table public.whatsapp_atendimentos
  add column if not exists acesso_remoto    text,
  add column if not exists acesso_remoto_em timestamptz,
  -- Evita pedir o ID de novo a cada mensagem do cliente enquanto ele nao manda.
  add column if not exists acesso_pedido_em timestamptz;
