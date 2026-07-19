// Camada de IA.
//
// A IA aqui NAO e um chatbot de conversa livre. Ela tem duas funcoes
// estritas e nada alem disso:
//
//   1. classificar()  -- essa mensagem no grupo e um chamado de suporte,
//                        uma conversa solta, ou um retorno sobre um chamado
//                        que ja esta em andamento?
//   2. diagnosticar() -- dado o problema relatado e os casos cadastrados na
//                        base, qual caso se aplica e qual o passo-a-passo?
//
// Duas travas duras, no codigo e nao no prompt (prompt se contorna):
//
//   - Sem caso compativel na base, ela NAO responde. Escala.
//   - Qualquer falha (API fora, JSON invalido, timeout) escala.
//
// O pior resultado possivel e o cliente receber um procedimento inventado.
// O segundo pior e ficar sem resposta e sem ninguem avisado. Escalar resolve
// os dois.

import type { CasoConhecimento } from '@/lib/tipos'

const MODELO_RESPOSTA = process.env.GROQ_MODEL_RESPOSTA || 'llama-3.3-70b-versatile'
const MODELO_CLASSIFICACAO = process.env.GROQ_MODEL_CLASSIFICACAO || 'llama-3.1-8b-instant'
// Modelos de visao entram e saem do catalogo da Groq sem aviso. O anterior
// (meta-llama/llama-4-scout) foi descontinuado e passou a responder 404, o
// que derrubava todo diagnostico com imagem. Para conferir o que existe hoje:
//   curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models
const MODELO_VISAO = process.env.GROQ_MODEL_VISAO || 'qwen/qwen3.6-27b'

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'

export function iaDisponivel(): boolean {
  return Boolean(process.env.GROQ_API_KEY)
}

type ConteudoMensagem =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

interface CorpoGroq {
  model: string
  temperature: number
  max_tokens: number
  response_format: { type: 'json_object' }
  messages: { role: 'system' | 'user'; content: ConteudoMensagem }[]
}

/**
 * Chama a Groq via fetch, sem SDK.
 *
 * O SDK era uma camada a mais que embrulhava toda falha de rede num
 * "Connection error." sem nome, sem status e sem corpo -- em producao isso
 * significou um chamado escalado sem que houvesse como saber se era chave
 * invalida, limite estourado, modelo inexistente ou timeout. Com fetch, o
 * erro que chega no log e o erro que aconteceu.
 *
 * Uma tentativa extra cobre a falha transitoria, que e o caso comum.
 */
async function chamarGroq(corpo: CorpoGroq, timeoutMs: number): Promise<string> {
  const chave = process.env.GROQ_API_KEY
  if (!chave) throw new Error('GROQ_API_KEY ausente')

  let ultimoErro = ''

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const resposta = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${chave}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!resposta.ok) {
        const detalhe = (await resposta.json().catch(() => ({}))) as {
          error?: { message?: string; code?: string }
        }
        const mensagem = detalhe.error?.message ?? `HTTP ${resposta.status}`

        // 4xx nao melhora repetindo: chave errada continua errada. So 429
        // (limite) e 5xx valem nova tentativa.
        if (resposta.status < 500 && resposta.status !== 429) {
          throw new Error(`Groq recusou (${resposta.status}): ${mensagem}`)
        }

        ultimoErro = `Groq indisponivel (${resposta.status}): ${mensagem}`
        continue
      }

      const json = (await resposta.json()) as {
        choices?: { message?: { content?: string } }[]
      }

      const conteudo = json.choices?.[0]?.message?.content
      if (!conteudo) throw new Error('Groq respondeu sem conteudo')

      return conteudo
    } catch (e) {
      const erro = e instanceof Error ? e : new Error(String(e))

      // Erro de recusa ja e definitivo -- nao repete.
      if (erro.message.startsWith('Groq recusou')) throw erro

      ultimoErro =
        erro.name === 'TimeoutError' || erro.name === 'AbortError'
          ? `Tempo esgotado apos ${timeoutMs}ms`
          : `${erro.name}: ${erro.message}`
    }
  }

  throw new Error(ultimoErro || 'Falha desconhecida ao chamar a Groq')
}

// ---------------------------------------------------------------------------
// 1. Classificacao
// ---------------------------------------------------------------------------

export type TipoMensagemClassificada =
  /** Relato de problema -- abre ou alimenta um chamado. */
  | 'solicitacao'
  /** Bom dia, obrigado, conversa entre membros -- nao vira chamado. */
  | 'conversa'
  /** Cliente confirmou que a orientacao resolveu. */
  | 'resolvido'
  /** Cliente disse que tentou e nao resolveu -- gatilho de escalonamento. */
  | 'nao_resolvido'
  /** Pediu explicitamente para falar com uma pessoa. */
  | 'pedido_humano'

export interface Classificacao {
  tipo: TipoMensagemClassificada
  urgencia: 'baixa' | 'normal' | 'alta'
  resumo: string
}

const PROMPT_CLASSIFICACAO = `Voce classifica mensagens de um grupo de WhatsApp de suporte tecnico.

Responda APENAS com JSON: {"tipo": "...", "urgencia": "...", "resumo": "..."}

Valores de "tipo":
- "solicitacao"   : relata um problema, erro, falha, ou pede ajuda tecnica.
- "conversa"      : saudacao, agradecimento, confirmacao vazia, papo entre membros, mensagem sem pedido.
- "resolvido"     : confirma que a orientacao anterior funcionou ("deu certo", "resolveu", "voltou a funcionar").
- "nao_resolvido" : diz que tentou e continua com problema ("nao funcionou", "continua igual", "ja tentei isso").
- "pedido_humano" : pede explicitamente falar com uma pessoa/atendente/responsavel.

Valores de "urgencia": "baixa", "normal", "alta".
Use "alta" so quando a operacao esta parada: sistema fora do ar, ninguem consegue trabalhar, prejuizo em andamento.

"resumo": no maximo 12 palavras, descrevendo o problema. String vazia se tipo for "conversa".

Na duvida entre "solicitacao" e "conversa", escolha "conversa" -- e melhor deixar passar um chamado (o atendente ve a mensagem no painel de qualquer forma) do que encher o painel de ruido.`

export interface OpcoesClassificacao {
  texto: string
  /** True quando o participante ja tem chamado aberto -- muda a leitura de
   *  "nao funcionou" de conversa solta para retorno sobre o chamado. */
  temChamadoAberto: boolean
  /** Ultima orientacao enviada pelo bot, se houver. */
  ultimaResposta?: string | null
}

export async function classificar(opcoes: OpcoesClassificacao): Promise<Classificacao> {
  const { texto, temChamadoAberto, ultimaResposta } = opcoes

  // Sem IA: trata tudo como solicitacao. Prefere ruido a perder chamado.
  if (!iaDisponivel() || !texto?.trim()) {
    return { tipo: 'solicitacao', urgencia: 'normal', resumo: texto?.slice(0, 80) ?? '' }
  }

  const contexto = temChamadoAberto
    ? `\n\nContexto: esta pessoa JA tem um chamado em andamento.${
        ultimaResposta ? ` A ultima orientacao enviada foi: "${ultimaResposta.slice(0, 300)}"` : ''
      }`
    : '\n\nContexto: esta pessoa nao tem chamado em andamento.'

  try {
    const conteudo = await chamarGroq(
      {
        model: MODELO_CLASSIFICACAO,
        temperature: 0,
        max_tokens: 150,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PROMPT_CLASSIFICACAO + contexto },
          { role: 'user', content: texto.slice(0, 1500) },
        ],
      },
      12_000,
    )

    const bruto = JSON.parse(conteudo || '{}') as Partial<Classificacao>

    const tiposValidos: TipoMensagemClassificada[] = [
      'solicitacao', 'conversa', 'resolvido', 'nao_resolvido', 'pedido_humano',
    ]

    return {
      tipo: tiposValidos.includes(bruto.tipo as TipoMensagemClassificada)
        ? (bruto.tipo as TipoMensagemClassificada)
        : 'solicitacao',
      urgencia: (['baixa', 'normal', 'alta'] as const).includes(bruto.urgencia as 'normal')
        ? (bruto.urgencia as 'baixa' | 'normal' | 'alta')
        : 'normal',
      resumo: typeof bruto.resumo === 'string' ? bruto.resumo.slice(0, 120) : '',
    }
  } catch (e) {
    // Classificador fora do ar nao pode engolir chamado. Mas o erro precisa
    // aparecer no log: silenciar aqui foi o que escondeu uma indisponibilidade
    // inteira da Groq atras de um comportamento aparentemente normal.
    console.error('[ia] classificacao falhou:', e instanceof Error ? e.message : e)
    return { tipo: 'solicitacao', urgencia: 'normal', resumo: texto.slice(0, 80) }
  }
}

// ---------------------------------------------------------------------------
// 2. Pre-filtro da base de conhecimento
// ---------------------------------------------------------------------------

/**
 * Reduz a base a um punhado de candidatos antes de chamar o modelo grande.
 *
 * Motivo: a base cresce e mandar tudo no prompt fica caro e degrada a
 * qualidade. Pontuacao simples por sobreposicao de termos -- suficiente ate
 * algumas centenas de casos. Passando disso, trocar por embeddings + pgvector.
 */
export function preFiltrarCasos(
  texto: string,
  casos: CasoConhecimento[],
  limite = 12,
): CasoConhecimento[] {
  const normalizar = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // remove acentos combinantes
      .replace(/[^a-z0-9\s]/g, ' ')

  const palavrasVazias = new Set([
    'a', 'o', 'as', 'os', 'de', 'da', 'do', 'em', 'no', 'na', 'um', 'uma',
    'para', 'com', 'que', 'e', 'nao', 'esta', 'ta', 'meu', 'minha', 'pra',
  ])

  const termos = new Set(
    normalizar(texto)
      .split(/\s+/)
      .filter((t) => t.length > 2 && !palavrasVazias.has(t)),
  )

  if (termos.size === 0) return casos.slice(0, limite)

  const pontuados = casos.map((caso) => {
    const alvo = normalizar(
      [caso.titulo, caso.categoria ?? '', ...caso.sintomas, caso.causa ?? ''].join(' '),
    )
    const palavrasAlvo = new Set(alvo.split(/\s+/).filter(Boolean))

    let pontos = 0
    for (const termo of termos) {
      if (palavrasAlvo.has(termo)) pontos += 3
      else if (alvo.includes(termo)) pontos += 1 // casa parcial: "bomba" em "bombeamento"
    }

    // Sintoma cadastrado que aparece inteiro na mensagem e sinal forte.
    for (const sintoma of caso.sintomas) {
      if (sintoma.length > 4 && normalizar(texto).includes(normalizar(sintoma))) pontos += 8
    }

    return { caso, pontos: pontos + caso.prioridade }
  })

  const comMatch = pontuados.filter((p) => p.pontos > 0)

  // Nenhum termo casou: manda os de maior prioridade e deixa o modelo decidir.
  // Ele ainda pode concluir que nenhum se aplica e escalar.
  const selecionados = comMatch.length > 0 ? comMatch : pontuados

  return selecionados
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, limite)
    .map((p) => p.caso)
}

// ---------------------------------------------------------------------------
// 3. Diagnostico
// ---------------------------------------------------------------------------

export interface Diagnostico {
  /** Texto pronto para enviar, ou null se for escalar. */
  texto: string | null
  escalar: boolean
  /** Caso da base que embasou a resposta. */
  casoId: string | null
  motivo: string
  confianca: 'alta' | 'media' | 'baixa'
}

const PROMPT_DIAGNOSTICO = `Voce e um assistente de suporte tecnico que responde em um grupo de WhatsApp.

REGRA ABSOLUTA: voce so pode orientar com base nos CASOS CONHECIDOS fornecidos abaixo.
Voce NAO tem conhecimento proprio sobre este sistema. Nao deduza, nao improvise,
nao adapte procedimento de um caso para outro problema, nao invente passo nenhum.
Se nenhum caso descrever o problema relatado, escale. Escalar e a resposta certa
e esperada -- nao e falha sua.

Responda APENAS com JSON:
{"caso_id": "...", "texto": "...", "escalar": true|false, "confianca": "alta|media|baixa", "motivo": "..."}

Quando UM caso claramente corresponde ao problema:
- "escalar": false
- "caso_id": o id exato do caso usado
- "texto": a orientacao para o cliente, em portugues do Brasil
- "confianca": "alta" se os sintomas batem direto, "media" se e provavel

Quando NENHUM caso corresponde, ou voce esta em duvida entre casos muito diferentes,
ou o problema parece mais grave do que os casos cobrem:
- "escalar": true
- "texto": null
- "motivo": uma frase curta explicando por que escalou

Como escrever "texto" -- siga a estrutura exatamente:

1) Uma frase curta reconhecendo o problema. Ela NAO pode repetir o conteudo do
   primeiro passo: e so uma abertura ("Vamos resolver isso!", "Entendi o que
   esta acontecendo.").
2) Linha em branco.
3) Os passos, numerados, na ordem exata do caso. Nao pule, nao reordene, nao
   junte dois passos numa linha.
4) Linha em branco.
5) Um pedido curto para a pessoa avisar se funcionou ou nao.

Regras de formatacao, todas obrigatorias:
- Cada passo numerado fica na PROPRIA LINHA. Use quebras de linha de verdade
  dentro da string JSON. Nunca escreva os passos seguidos no mesmo paragrafo.
- Reescreva cada passo em frase curta e natural, mas sem mudar o que ele manda
  fazer nem a ordem.
- Se o cliente ja disse que tentou algo, pule esse passo em vez de repeti-lo.
- Negrito do WhatsApp e *asterisco simples*, nunca **duplo**.
- Sem titulo, sem bullet com hifen, sem markdown alem do negrito.
- Maximo de 900 caracteres.
- Nao mencione "caso", "base de conhecimento" nem nada interno do sistema.

Assim a mensagem deve CHEGAR no celular do cliente:

  Entendi, vamos verificar isso.

  1. Confira se a luz da impressora esta acesa
  2. Verifique o cabo USB nas duas pontas
  3. Desligue a impressora, espere 10 segundos e ligue de novo

  Me avisa se funcionou!`

/**
 * Conserta quebras de linha antes do texto sair para o WhatsApp.
 *
 * O modelo as vezes escreve a sequencia literal barra-n dentro da string JSON
 * em vez de uma quebra real. Isso passa pelo JSON.parse sem erro e chega no
 * celular do cliente como "\\n" visivel no meio da mensagem, transformando o
 * passo-a-passo num paragrafo unico ilegivel.
 *
 * Tratar aqui e mais confiavel do que insistir no prompt: nao depende de o
 * modelo obedecer.
 */
function normalizarQuebras(texto: string): string {
  return texto
    .replace(/\\r\\n|\\n|\\r/g, '\n') // sequencias literais viram quebra real
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n') // no maximo uma linha em branco seguida
    .replace(/[ \t]+$/gm, '') // espaco sobrando no fim das linhas
    .trim()
}

export interface OpcoesDiagnostico {
  /** Problema relatado pelo cliente. */
  problema: string
  /** Casos candidatos, ja pre-filtrados. */
  casos: CasoConhecimento[]
  /** Ultimas mensagens do chamado, mais antiga primeiro. */
  historico?: { direcao: 'recebida' | 'enviada'; conteudo: string }[]
  /** Casos resolvidos por humanos, como contexto complementar. */
  aprendidos?: { problema: string; solucao: string }[]
  /** URL publica de imagem enviada pelo cliente (print de erro). */
  imagemUrl?: string | null
  /** Nome de quem pediu, para personalizar o tratamento. */
  nomeContato?: string | null
  /** Fora da janela de atendimento: avisa que humano so volta depois. */
  foraDoHorario?: boolean
  /** Aviso a acrescentar quando fora do horario. */
  avisoHorario?: string | null
}

export async function diagnosticar(opcoes: OpcoesDiagnostico): Promise<Diagnostico> {
  const { problema, casos, historico, aprendidos, imagemUrl, nomeContato } = opcoes

  const escalar = (motivo: string): Diagnostico => ({
    texto: null,
    escalar: true,
    casoId: null,
    motivo,
    confianca: 'baixa',
  })

  // --- Travas duras --------------------------------------------------------
  if (!iaDisponivel()) return escalar('IA nao configurada (GROQ_API_KEY ausente)')
  if (!casos.length) return escalar('Nenhum caso cadastrado na base de conhecimento')
  if (!problema?.trim()) return escalar('Mensagem sem texto para diagnosticar')

  // Caso marcado como escalar_direto que bate sozinho: nem chama o modelo.
  if (casos.length === 1 && casos[0].escalar_direto) {
    return { ...escalar(`Caso "${casos[0].titulo}" exige atendimento humano`), casoId: casos[0].id }
  }

  // --- Monta o contexto ----------------------------------------------------
  const blocos: string[] = []

  blocos.push(
    'CASOS CONHECIDOS:\n' +
      casos
        .map((c) => {
          const partes = [
            `[id: ${c.id}]`,
            `Titulo: ${c.titulo}`,
            c.categoria ? `Categoria: ${c.categoria}` : null,
            c.sintomas.length ? `Sintomas relatados pelo cliente: ${c.sintomas.join('; ')}` : null,
            c.causa ? `Causa: ${c.causa}` : null,
            c.passos.length
              ? `Passos:\n${c.passos.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`
              : null,
            c.observacao ? `Observacao final: ${c.observacao}` : null,
            c.imagens.length ? `Tem ${c.imagens.length} imagem(ns) de exemplo cadastrada(s).` : null,
            c.escalar_direto
              ? 'ATENCAO: este caso NAO pode ser resolvido pelo bot. Se ele corresponder, escale.'
              : null,
          ].filter(Boolean)
          return partes.join('\n')
        })
        .join('\n\n---\n\n'),
  )

  if (aprendidos?.length) {
    blocos.push(
      'CASOS RESOLVIDOS ANTERIORMENTE POR ATENDENTES (contexto complementar, ' +
        'use com mais cautela que os casos oficiais acima):\n' +
        aprendidos
          .slice(0, 20)
          .map((a) => `- Problema: ${a.problema}\n  Solucao: ${a.solucao}`)
          .join('\n'),
    )
  }

  if (historico?.length) {
    blocos.push(
      'HISTORICO DESTA CONVERSA (mais antiga primeiro):\n' +
        historico
          .slice(-8)
          .map((m) => `${m.direcao === 'recebida' ? 'Cliente' : 'Suporte'}: ${m.conteudo}`)
          .join('\n'),
    )
  }

  if (nomeContato) blocos.push(`Nome de quem pediu ajuda: ${nomeContato}`)

  // --- Chamada -------------------------------------------------------------
  const usarVisao = Boolean(imagemUrl)

  // Com imagem do cliente, anexa tambem as imagens de exemplo dos casos
  // candidatos: comparar o print recebido com "e assim que este problema
  // aparece" e muito mais confiavel do que decidir pela descricao escrita.
  //
  // Teto de 3 exemplos: cada imagem custa tokens e diminui a atencao do
  // modelo no que importa, que e a imagem do cliente.
  const exemplos = usarVisao
    ? casos
        .flatMap((c) => c.imagens.slice(0, 1).map((url) => ({ url, titulo: c.titulo })))
        .slice(0, 3)
    : []

  const conteudoUsuario = usarVisao
    ? [
        {
          type: 'text' as const,
          text:
            `Problema relatado: ${problema}\n\n` +
            'A PRIMEIRA imagem foi enviada pelo cliente agora.' +
            (exemplos.length
              ? ' As seguintes sao exemplos de como certos casos conhecidos costumam aparecer, ' +
                'nesta ordem: ' +
                exemplos.map((e, i) => `(${i + 2}) ${e.titulo}`).join(', ') +
                '. Compare a imagem do cliente com elas, mas so escolha um caso se ' +
                'os sintomas tambem baterem.'
              : ''),
        },
        { type: 'image_url' as const, image_url: { url: imagemUrl! } },
        ...exemplos.map((e) => ({
          type: 'image_url' as const,
          image_url: { url: e.url },
        })),
      ]
    : `Problema relatado: ${problema}`

  const sistema = `${PROMPT_DIAGNOSTICO}\n\n${blocos.join('\n\n')}`

  const executar = (comVisao: boolean, entrada: ConteudoMensagem) =>
    chamarGroq(
      {
        model: comVisao ? MODELO_VISAO : MODELO_RESPOSTA,
        temperature: 0.2,
        // O modelo de visao raciocina antes de responder, e esse raciocinio
        // consome do mesmo orcamento. Com 700 tokens ele gastava tudo
        // pensando e devolvia string vazia, que a Groq rejeita com
        // json_validate_failed -- um chamado perdido por falta de espaco.
        // Medido num print real: 1077 tokens ate a resposta completa.
        max_tokens: comVisao ? 2500 : 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sistema },
          { role: 'user', content: entrada },
        ],
      },
      // Visao demora mais: o modelo ainda baixa cada imagem antes de comecar.
      comVisao ? 40_000 : 25_000,
    )

  try {
    let conteudo: string

    try {
      conteudo = await executar(usarVisao, conteudoUsuario)
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e)

      // Modelo de visao indisponivel nao pode zerar o atendimento.
      //
      // Foi o que aconteceu em producao: o modelo saiu do catalogo da Groq,
      // toda mensagem com foto passou a escalar na hora, e o cliente recebeu
      // o pedido de AnyDesk sem que nenhum passo tivesse sido tentado. Sem a
      // imagem a IA ainda tem o texto e o historico -- pior que analisar a
      // foto, muito melhor que nao tentar nada.
      // json_validate_failed entra aqui pelo mesmo motivo: o modelo de
      // raciocinio pode estourar o orcamento pensando e devolver vazio.
      const visaoFalhou =
        usarVisao &&
        (erro.includes('does not exist') ||
          erro.includes('(404)') ||
          erro.includes('json_validate_failed') ||
          erro.includes('Failed to validate JSON'))

      if (!visaoFalhou) throw e

      console.error(`[ia] visao falhou (${MODELO_VISAO}): ${erro} -- seguindo so com texto`)

      conteudo = await executar(
        false,
        `${problema}\n\n(O cliente enviou uma imagem, mas nao foi possivel analisa-la. ` +
          'Use apenas a descricao e o historico.)',
      )
    }

    const bruto = JSON.parse(conteudo || '{}') as {
      caso_id?: string
      texto?: string | null
      escalar?: boolean
      confianca?: string
      motivo?: string
    }

    if (bruto.escalar === true) {
      return escalar(bruto.motivo || 'A IA nao encontrou caso correspondente na base')
    }

    const texto = normalizarQuebras(typeof bruto.texto === 'string' ? bruto.texto : '')
    if (!texto) return escalar('A IA nao produziu resposta utilizavel')

    // O caso citado tem que existir de verdade entre os candidatos. Se o
    // modelo devolveu um id inventado, a resposta nao esta ancorada na base.
    const caso = casos.find((c) => c.id === bruto.caso_id)
    if (!caso) return escalar('A IA citou um caso inexistente -- resposta nao confiavel')
    if (caso.escalar_direto) {
      return { ...escalar(`Caso "${caso.titulo}" exige atendimento humano`), casoId: caso.id }
    }

    return {
      texto: texto.slice(0, 1000),
      escalar: false,
      casoId: caso.id,
      motivo: `Caso aplicado: ${caso.titulo}`,
      confianca: (['alta', 'media', 'baixa'] as const).includes(bruto.confianca as 'alta')
        ? (bruto.confianca as 'alta' | 'media' | 'baixa')
        : 'media',
    }
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e)
    console.error('[ia] diagnostico falhou:', mensagem)
    return escalar(`Falha na IA: ${mensagem}`)
  }
}
