-- Casos de exemplo para a base de conhecimento.
--
-- Rode SO se quiser ver o sistema funcionando antes de cadastrar os seus.
-- Depois apague: casos genericos fazem a IA responder besteira com confianca.
--
-- Use estes como MODELO de como escrever um caso bom:
--
--   sintomas -> escritos como o cliente fala, nao como o tecnico fala.
--               Quanto mais variacoes, melhor o reconhecimento.
--   passos   -> um por linha, na ordem, em linguagem de quem esta na ponta.
--               Sem jargao, sem "verifique as configuracoes de rede".

insert into public.whatsapp_base_conhecimento
  (titulo, categoria, sintomas, causa, passos, observacao, escalar_direto, prioridade)
values
  (
    'Sistema nao abre / tela branca',
    'Sistema',
    array[
      'sistema nao abre',
      'tela branca',
      'nao carrega',
      'travou na tela de carregamento',
      'nao entra no sistema',
      'fica carregando direto'
    ],
    'Cache do navegador corrompido apos atualizacao',
    array[
      'Feche completamente o navegador (todas as janelas)',
      'Abra novamente e pressione Ctrl + Shift + R na tela do sistema',
      'Se continuar, tente abrir em uma aba anonima (Ctrl + Shift + N)',
      'Funcionando na aba anonima, limpe o cache: Ctrl + Shift + Delete, marque "Imagens e arquivos em cache" e confirme'
    ],
    'Se nem na aba anonima abrir, me avise que o problema e outro.',
    false,
    10
  ),
  (
    'Impressora nao imprime',
    'Impressora',
    array[
      'impressora nao imprime',
      'nao sai cupom',
      'nao imprime nota',
      'impressora travada',
      'nao ta imprimindo',
      'papel nao sai'
    ],
    'Impressora sem energia, sem papel, ou cabo solto',
    array[
      'Confira se a luz da impressora esta acesa',
      'Verifique se tem papel e se a tampa esta bem fechada',
      'Confira o cabo USB nas duas pontas: na impressora e no computador',
      'Desligue a impressora, espere 10 segundos e ligue de novo',
      'Tente imprimir novamente pelo sistema'
    ],
    'Se a luz estiver piscando em vermelho, me chame que ai e outro problema.',
    false,
    10
  ),
  (
    'Internet caiu / sem conexao',
    'Rede',
    array[
      'internet caiu',
      'sem internet',
      'sistema fora do ar',
      'nao conecta',
      'internet lenta demais',
      'ta sem sinal'
    ],
    'Queda do provedor ou roteador travado',
    array[
      'Olhe as luzes do roteador: a luz de internet deve estar acesa e fixa',
      'Se estiver vermelha ou apagada, desligue o roteador da tomada',
      'Espere 30 segundos e ligue novamente',
      'Aguarde 2 minutos ate as luzes estabilizarem',
      'Teste abrindo qualquer site no navegador'
    ],
    'Se depois disso continuar sem internet, o problema e do provedor -- me avise que eu abro chamado com eles.',
    false,
    5
  ),
  (
    'Problema com valores, fechamento de caixa ou estorno',
    'Financeiro',
    array[
      'diferenca no caixa',
      'valor errado',
      'preciso estornar',
      'cancelar venda',
      'caixa nao fecha',
      'sobrou dinheiro',
      'faltou dinheiro'
    ],
    'Envolve conferencia de valores -- exige validacao humana',
    array[]::text[],
    null,
    true,  -- nunca resolvido pelo bot: sempre chama atendente
    20
  );
