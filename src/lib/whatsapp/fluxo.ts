// O motor de atendimento.
//
// Toda mensagem recebida passa por esta cascata, na ordem exata abaixo.
// Cada passo pode interromper o fluxo -- mas a mensagem SEMPRE fica gravada
// antes de qualquer interrupcao. Essa e a garantia central do sistema: nao
// importa o que a automacao decida, um humano consegue ver tudo no painel.
//
//   01. Mensagem enviada por nos mesmos                 -> descarta
//   02. Idempotencia (o Z-API reenvia eventos)          -> descarta duplicada
//   03. Grupo conhecido? (auto-cadastra como inativo)   -> para se desconhecido
//   04. Privado: participa de grupo ativo?              -> para se nao
//       Participando, responde "fale no grupo" e para
//   05. Grava a mensagem
//   06. Interruptor geral desligado                     -> para (so grava)
//   07. Numero na lista de ignorados                    -> para (so grava)
//   08. Classificacao: e chamado ou conversa solta?     -> para se conversa
//   09. Resolve/cria o chamado e vincula a mensagem
//   10. Atendente humano ja assumiu                     -> bot cala a boca
//   11. Cliente confirmou que resolveu                  -> fecha o chamado
//   12. Cliente pediu humano / disse que nao resolveu   -> escala
//   13. Chamado ja escalado                             -> bot cala a boca
//   14. Anti-flood                                      -> para
//   15. Diagnostico pela IA sobre a base de conhecimento
//   16. Achou caso -> responde no grupo | nao achou -> escala
//
// Nenhuma excecao escapa daqui. Se o webhook devolver 500, o Z-API reenvia o
// evento e a mensagem seria processada de novo.

import { criarClienteAdmin } from '@/lib/supabase/admin'
import { enviarTexto } from '@/lib/whatsapp/zapi'
import { normalizarTelefone, telefonesBatem, paraEnvio } from '@/lib/whatsapp/telefone'
import { dentroDoHorario, aplicarVariaveisHorario } from '@/lib/whatsapp/horario'
import { classificar, diagnosticar, preFiltrarCasos, iaDisponivel } from '@/lib/whatsapp/ia'
import { dispararAlerta } from '@/lib/whatsapp/alertas'
import { participaDeGrupoAtivo, sincronizarParticipantes } from '@/lib/whatsapp/participantes'
import { rehospedarMidia, urlParaVisao } from '@/lib/whatsapp/midia'
import { extrairAcessoRemoto } from '@/lib/whatsapp/acesso-remoto'
import type {
  Atendimento,
  CasoConhecimento,
  Config,
  Grupo,
  PayloadZAPI,
  TipoMensagem,
} from '@/lib/tipos'

export interface ResultadoProcessamento {
  acao: string
  detalhe?: string
  atendimentoId?: string
}

// ---------------------------------------------------------------------------
// Extracao do payload
// ---------------------------------------------------------------------------

interface MensagemExtraida {
  texto: string
  tipo: TipoMensagem
  /** URL do arquivo no storage temporario do Z-API. */
  midiaUrl: string | null
  midiaMime: string | null
  midiaNome: string | null
}

function extrairConteudo(payload: PayloadZAPI): MensagemExtraida {
  const vazio = { midiaUrl: null, midiaMime: null, midiaNome: null }

  if (payload.image?.imageUrl) {
    return {
      texto: payload.image.caption?.trim() || '[imagem enviada]',
      tipo: 'imagem',
      midiaUrl: payload.image.imageUrl,
      midiaMime: payload.image.mimeType ?? null,
      midiaNome: null,
    }
  }

  if (payload.video?.videoUrl) {
    return {
      texto: payload.video.caption?.trim() || '[video enviado]',
      tipo: 'video',
      midiaUrl: payload.video.videoUrl,
      midiaMime: payload.video.mimeType ?? null,
      midiaNome: null,
    }
  }

  if (payload.audio?.audioUrl) {
    // Sem transcricao ainda -- audio sempre vai para humano.
    return {
      texto: '[audio enviado]',
      tipo: 'audio',
      midiaUrl: payload.audio.audioUrl,
      midiaMime: payload.audio.mimeType ?? null,
      midiaNome: null,
    }
  }

  if (payload.document?.documentUrl) {
    return {
      texto: `[documento: ${payload.document.fileName ?? 'arquivo'}]`,
      tipo: 'documento',
      midiaUrl: payload.document.documentUrl,
      midiaMime: payload.document.mimeType ?? null,
      midiaNome: payload.document.fileName ?? null,
    }
  }

  const texto = (payload.text?.message ?? payload.message ?? '').toString().trim()
  return { texto, tipo: texto ? 'texto' : 'outro', ...vazio }
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export async function processarMensagem(payload: PayloadZAPI): Promise<ResultadoProcessamento> {
  const supabase = criarClienteAdmin()

  // --- 01. Eco das nossas proprias mensagens ------------------------------
  if (payload.fromMe === true) {
    return { acao: 'ignorado', detalhe: 'mensagem enviada por nos' }
  }

  const ehGrupo = payload.isGroup === true
  const chatId = (payload.phone ?? '').toString()
  if (!chatId) return { acao: 'ignorado', detalhe: 'payload sem phone' }

  // Em grupo, `phone` e o ID do grupo e quem falou vem em participantPhone.
  const numeroContato = ehGrupo
    ? normalizarTelefone(payload.participantPhone)
    : normalizarTelefone(chatId)

  if (ehGrupo && !numeroContato) {
    return { acao: 'ignorado', detalhe: 'mensagem de grupo sem participantPhone' }
  }

  const nomeContato = payload.senderName?.trim() || null
  const messageId = payload.messageId ?? null
  const { texto, tipo, midiaUrl, midiaMime, midiaNome } = extrairConteudo(payload)

  // --- 02. Idempotencia ----------------------------------------------------
  if (messageId) {
    const { data: existente } = await supabase
      .from('whatsapp_mensagens')
      .select('id')
      .eq('zapi_message_id', messageId)
      .maybeSingle()

    if (existente) return { acao: 'duplicada', detalhe: messageId }
  }

  const { data: configData } = await supabase.from('whatsapp_config').select('*').eq('id', 1).single()
  const config = configData as Config | null
  if (!config) return { acao: 'erro', detalhe: 'whatsapp_config nao encontrada (rode as migrations)' }

  // --- 03 / 04. Grupo ou privado ------------------------------------------
  let grupo: Grupo | null = null

  if (ehGrupo) {
    grupo = await resolverGrupo(chatId, payload.chatName ?? null)

    // Grupo novo entra desativado. Aparece nas Configuracoes esperando um
    // clique -- assim adicionar o numero num grupo qualquer nao faz o bot
    // sair respondendo sozinho.
    if (!grupo || !grupo.ativo) {
      return { acao: 'grupo_inativo', detalhe: `${payload.chatName ?? chatId} nao esta ativo` }
    }

    // Rede de seguranca para a lista de participantes: se o grupo foi ativado
    // e nunca sincronizou, ninguem dele seria reconhecido no privado. Roda uma
    // vez so, na primeira mensagem apos a ativacao.
    await garantirParticipantes(grupo)
  } else {
    const resultadoPrivado = await tratarPrivado({ numeroContato, config, texto, messageId })
    if (resultadoPrivado) return resultadoPrivado
  }

  // --- 05. Grava a mensagem -----------------------------------------------
  //
  // A midia e rehospedada ANTES de gravar: a URL do Z-API expira, e um
  // chamado consultado dias depois mostraria imagem quebrada exatamente
  // quando o historico e mais util.
  const midia = midiaUrl
    ? await rehospedarMidia(midiaUrl, {
        mimeType: midiaMime,
        nome: midiaNome,
        prefixo: grupo ? `grupos/${grupo.id}` : 'privado',
      })
    : null

  if (midia?.erro) console.error('[fluxo] falha ao rehospedar midia:', midia.erro)

  const { data: mensagemSalva, error: erroMensagem } = await supabase
    .from('whatsapp_mensagens')
    .insert({
      grupo_id: grupo?.id ?? null,
      atendimento_id: null, // vinculado no passo 09, se virar chamado
      direcao: 'recebida',
      tipo,
      conteudo: texto,
      remetente_numero: numeroContato,
      remetente_nome: nomeContato,
      zapi_message_id: messageId,
      // Se a rehospedagem falhar, ainda guarda a original: melhor um link que
      // talvez expire do que nenhum.
      midia_url: midia?.url ?? midiaUrl,
      midia_tipo: midia?.mimeType ?? midiaMime,
      midia_nome: midiaNome,
      midia_original: midiaUrl,
      raw: payload as unknown as Record<string, unknown>,
    })
    .select('id')
    .single()

  if (erroMensagem) {
    // Corrida entre dois eventos do mesmo messageId: o unique index barrou o
    // segundo. Isso e a idempotencia funcionando, nao um erro.
    if (erroMensagem.code === '23505') return { acao: 'duplicada', detalhe: messageId ?? '' }
    return { acao: 'erro', detalhe: `falha ao gravar mensagem: ${erroMensagem.message}` }
  }

  const mensagemId = (mensagemSalva as { id: string }).id

  // --- 06. Interruptor geral ----------------------------------------------
  if (!config.bot_ativo) {
    await vincularAChamadoExistente(mensagemId, grupo, numeroContato)
    return { acao: 'bot_desligado', detalhe: 'mensagem gravada, automacao desligada' }
  }

  // --- 07. Numeros ignorados ----------------------------------------------
  if (await numeroIgnorado(numeroContato)) {
    await vincularAChamadoExistente(mensagemId, grupo, numeroContato)
    return { acao: 'numero_ignorado', detalhe: numeroContato }
  }

  // --- 08. Classificacao ---------------------------------------------------
  const chamadoExistente = await buscarChamadoVivo(grupo?.id ?? null, numeroContato)

  const classificacao =
    config.ia_classificacao_ativa && tipo === 'texto'
      ? await classificar({
          texto,
          temChamadoAberto: Boolean(chamadoExistente),
          ultimaResposta: chamadoExistente ? await ultimaRespostaDoBot(chamadoExistente.id) : null,
        })
      : { tipo: 'solicitacao' as const, urgencia: 'normal' as const, resumo: texto.slice(0, 80) }

  // Conversa solta sem chamado aberto: fica gravada e nao polui o painel.
  if (classificacao.tipo === 'conversa' && !chamadoExistente) {
    return { acao: 'conversa_ignorada', detalhe: classificacao.resumo }
  }

  // --- 09. Resolve o chamado ----------------------------------------------
  const atendimento =
    chamadoExistente ??
    (await criarChamado({
      grupo,
      numeroContato,
      nomeContato,
      urgencia: classificacao.urgencia,
      resumo: classificacao.resumo,
    }))

  if (!atendimento) return { acao: 'erro', detalhe: 'falha ao criar chamado' }

  await supabase
    .from('whatsapp_mensagens')
    .update({ atendimento_id: atendimento.id })
    .eq('id', mensagemId)

  await supabase
    .from('whatsapp_atendimentos')
    .update({
      ultima_mensagem_em: new Date().toISOString(),
      ...(nomeContato && !atendimento.contato_nome ? { contato_nome: nomeContato } : {}),
      // Cliente voltou a falar: sai de "aguardando cliente".
      ...(atendimento.status === 'aguardando_cliente' ? { status: 'em_andamento' } : {}),
    })
    .eq('id', atendimento.id)

  // Visao usa a copia rehospedada: a original do Z-API pode ja ter expirado, e
  // alguns hosts bloqueiam hotlink e devolvem 403 para a Groq.
  const imagemParaVisao = tipo === 'imagem' ? urlParaVisao(midia?.url ?? null, midiaUrl) : null

  // Se ja pedimos o acesso remoto, tenta reconhecer o ID nesta mensagem. Faz
  // o dado estar esperando no chamado quando o atendente abre, em vez de ele
  // ter que garimpar na conversa.
  if (atendimento.acesso_pedido_em && !atendimento.acesso_remoto && tipo === 'texto') {
    const acesso = extrairAcessoRemoto(texto, numeroContato)
    if (acesso) {
      await supabase
        .from('whatsapp_atendimentos')
        .update({ acesso_remoto: acesso, acesso_remoto_em: new Date().toISOString() })
        .eq('id', atendimento.id)

      atendimento.acesso_remoto = acesso
    }
  }

  const contexto: Contexto = {
    atendimento,
    grupo,
    config,
    chatId,
    payload,
    texto,
    imagemUrl: imagemParaVisao,
    nomeContato,
    tipo,
  }

  // --- 10. Humano assumiu --------------------------------------------------
  if (atendimento.usuario_id) {
    return { acao: 'humano_no_comando', atendimentoId: atendimento.id }
  }

  // --- 11. Cliente confirmou que resolveu ---------------------------------
  if (classificacao.tipo === 'resolvido') {
    return await fecharComoResolvido(contexto)
  }

  // --- 12. Pediu humano ou disse que nao resolveu -------------------------
  if (classificacao.tipo === 'pedido_humano') {
    return await escalar(contexto, 'Cliente pediu para falar com um atendente', 'normal')
  }

  if (classificacao.tipo === 'nao_resolvido') {
    const tentativas = atendimento.ia_tentativas + 1
    await supabase
      .from('whatsapp_atendimentos')
      .update({ ia_tentativas: tentativas })
      .eq('id', atendimento.id)

    if (tentativas >= config.max_tentativas_ia) {
      return await escalar(
        { ...contexto, atendimento: { ...atendimento, ia_tentativas: tentativas } },
        'A orientacao automatica nao resolveu o problema',
        'normal',
      )
    }
    // Ainda tem tentativa: segue para o diagnostico, agora com o historico
    // mostrando o que ja foi tentado e nao funcionou.
  }

  // --- 13. Ja escalado -----------------------------------------------------
  if (atendimento.ia_escalado) {
    return { acao: 'aguardando_humano', atendimentoId: atendimento.id }
  }

  // --- 14. Anti-flood ------------------------------------------------------
  if (grupo && grupo.anti_flood_minutos > 0) {
    if (await respondeuRecentemente(atendimento.id, grupo.anti_flood_minutos)) {
      return { acao: 'anti_flood', atendimentoId: atendimento.id }
    }
  }

  // --- 15 / 16. Diagnostico ------------------------------------------------
  if (!config.ia_ativa || !iaDisponivel()) {
    return await escalar(contexto, 'Resposta automatica desligada', 'normal')
  }

  if (atendimento.ia_tentativas >= config.max_tentativas_ia) {
    return await escalar(contexto, 'Limite de tentativas automaticas atingido', 'normal')
  }

  if (tipo === 'audio') {
    return await escalar(contexto, 'Mensagem de audio -- precisa de escuta humana', 'normal')
  }

  return await diagnosticarEResponder(contexto, classificacao.urgencia)
}

// ---------------------------------------------------------------------------
// Contexto compartilhado pelos passos finais
// ---------------------------------------------------------------------------

interface Contexto {
  atendimento: Atendimento
  grupo: Grupo | null
  config: Config
  chatId: string
  payload: PayloadZAPI
  texto: string
  imagemUrl: string | null
  nomeContato: string | null
  tipo: TipoMensagem
}

// ---------------------------------------------------------------------------
// Passo 15/16 -- diagnostico
// ---------------------------------------------------------------------------

async function diagnosticarEResponder(
  contexto: Contexto,
  urgencia: 'baixa' | 'normal' | 'alta',
): Promise<ResultadoProcessamento> {
  const supabase = criarClienteAdmin()
  const { atendimento, grupo, texto, imagemUrl, nomeContato } = contexto

  const [casosResposta, aprendidosResposta, historicoResposta] = await Promise.all([
    supabase.from('whatsapp_base_conhecimento').select('*').eq('ativo', true),
    supabase
      .from('whatsapp_conhecimento_aprendido')
      .select('problema, solucao')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('whatsapp_mensagens')
      .select('direcao, conteudo')
      .eq('atendimento_id', atendimento.id)
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const casos = (casosResposta.data ?? []) as unknown as CasoConhecimento[]

  if (!casos.length) {
    return await escalar(contexto, 'Base de conhecimento vazia -- nenhum caso cadastrado', urgencia)
  }

  const candidatos = preFiltrarCasos(texto, casos)

  const historico = ((historicoResposta.data ?? []) as unknown as Array<{
    direcao: 'recebida' | 'enviada'
    conteudo: string | null
  }>)
    .reverse()
    .filter((m) => m.conteudo)
    .map((m) => ({ direcao: m.direcao, conteudo: m.conteudo as string }))

  const diagnostico = await diagnosticar({
    problema: texto,
    casos: candidatos,
    historico,
    aprendidos: (aprendidosResposta.data ?? []) as unknown as { problema: string; solucao: string }[],
    imagemUrl,
    nomeContato,
  })

  // Prioridade sai do caso reconhecido, nao de um palpite sobre o texto.
  // Quem sabe que "bomba parada" para a operacao e quem escreveu o caso --
  // o modelo so leu a frase. Quando a IA nao reconhece caso nenhum, ai sim
  // vale a leitura dela sobre a urgencia.
  const casoReconhecido = diagnostico.casoId
    ? candidatos.find((c) => c.id === diagnostico.casoId)
    : null

  const prioridade = casoReconhecido?.urgencia_padrao ?? urgencia
  const motivoPrioridade = casoReconhecido
    ? `Caso "${casoReconhecido.titulo}" e ${casoReconhecido.urgencia_padrao}`
    : `Urgencia estimada pela IA a partir da mensagem`

  if (diagnostico.escalar || !diagnostico.texto) {
    return await escalar(
      contexto,
      diagnostico.motivo,
      prioridade,
      motivoPrioridade,
      casoReconhecido?.pedir_acesso_remoto,
    )
  }

  // Fora do horario: entrega a orientacao mesmo assim, mas deixa claro que
  // atendente humano so volta na proxima janela.
  const foraDoHorario = grupo ? !dentroDoHorario(grupo) : false
  const corpo = foraDoHorario && grupo
    ? `${diagnostico.texto}\n\n_${aplicarVariaveisHorario(
        'Obs.: estamos fora do horario de atendimento ({{horario_inicio}} as {{horario_fim}}). Se isso nao resolver, me avise que um atendente retorna a partir das {{horario_inicio}}.',
        grupo,
      )}_`
    : diagnostico.texto

  const enviou = await responder(contexto, corpo, true)
  if (!enviou) return await escalar(contexto, 'Falha ao enviar a resposta pelo WhatsApp', urgencia)

  const agora = new Date().toISOString()

  await supabase
    .from('whatsapp_atendimentos')
    .update({
      ia_tentativas: atendimento.ia_tentativas + 1,
      caso_sugerido_id: diagnostico.casoId,
      status: 'aguardando_cliente',
      prioridade,
      motivo_prioridade: motivoPrioridade,
      ...(atendimento.primeira_resposta_em ? {} : { primeira_resposta_em: agora }),
    })
    .eq('id', atendimento.id)

  if (diagnostico.casoId) {
    await supabase.rpc('incrementar_uso_caso', { caso: diagnostico.casoId }).then(
      () => undefined,
      // A funcao e opcional; se nao existir, a metrica so nao e contabilizada.
      () => undefined,
    )
  }

  return {
    acao: 'respondido_pela_ia',
    detalhe: diagnostico.motivo,
    atendimentoId: atendimento.id,
  }
}

// ---------------------------------------------------------------------------
// Escalonamento
// ---------------------------------------------------------------------------

async function escalar(
  contexto: Contexto,
  motivo: string,
  urgencia: 'baixa' | 'normal' | 'alta',
  motivoPrioridade?: string,
  /** Do caso reconhecido. undefined quando nenhum caso foi identificado. */
  pedeAcessoRemoto?: boolean,
): Promise<ResultadoProcessamento> {
  const supabase = criarClienteAdmin()
  const { atendimento, grupo, config, texto } = contexto

  const agora = new Date()
  const noHorario = grupo ? dentroDoHorario(grupo, agora) : true

  await supabase
    .from('whatsapp_atendimentos')
    .update({
      ia_escalado: true,
      escalado_em: agora.toISOString(),
      motivo_escalonamento: motivo,
      status: 'em_andamento',
      prioridade: urgencia,
      motivo_prioridade: motivoPrioridade ?? 'Urgencia estimada pela IA',
      // Marca a entrada na fila. Sem isso a espera seria contada desde a
      // criacao do chamado, inflando o tempo de quem a IA tentou ajudar antes.
      ...(atendimento.entrou_na_fila_em ? {} : { entrou_na_fila_em: agora.toISOString() }),
    })
    .eq('id', atendimento.id)

  // Avisa o cliente. Fora do horario, a mensagem diz quando alguem volta.
  const aviso =
    noHorario || !grupo
      ? 'Entendi. Vou chamar um atendente para te ajudar com isso. Aguarde um momento, por favor.'
      : aplicarVariaveisHorario(grupo.mensagem_fora_horario, grupo)

  // Pede o acesso remoto junto com o aviso. Pedir so quando o atendente
  // assume custa mais uma ida e volta, e ate la o cliente pode ter saido de
  // perto do computador.
  const pedirAcesso =
    config.pedir_acesso_remoto &&
    !atendimento.acesso_remoto &&
    !atendimento.acesso_pedido_em &&
    // Caso marcado como incompativel nao pede: mandar instalar AnyDesk em
    // quem esta sem internet e pedir o impossivel.
    pedeAcessoRemoto !== false

  const mensagem = pedirAcesso ? `${aviso}\n\n${config.mensagem_acesso_remoto}` : aviso

  await responder(contexto, mensagem, true)

  if (pedirAcesso) {
    await supabase
      .from('whatsapp_atendimentos')
      .update({ acesso_pedido_em: agora.toISOString() })
      .eq('id', atendimento.id)
  }

  await dispararAlerta({
    atendimento,
    grupo,
    config,
    motivo,
    urgencia: urgencia === 'alta' ? 'alta' : 'normal',
    trechoProblema: texto.slice(0, 200),
  })

  return { acao: 'escalado', detalhe: motivo, atendimentoId: atendimento.id }
}

// ---------------------------------------------------------------------------
// Fechamento por confirmacao do cliente
// ---------------------------------------------------------------------------

async function fecharComoResolvido(contexto: Contexto): Promise<ResultadoProcessamento> {
  const supabase = criarClienteAdmin()
  const { atendimento } = contexto
  const agora = new Date().toISOString()

  await supabase
    .from('whatsapp_atendimentos')
    .update({ status: 'resolvido', resolvido_por: 'ia', resolvido_em: agora })
    .eq('id', atendimento.id)

  // Contabiliza o acerto do caso que foi usado -- e o que permite ver depois
  // quais casos da base realmente resolvem e quais so enrolam.
  if (atendimento.caso_sugerido_id) {
    await supabase
      .rpc('incrementar_acerto_caso', { caso: atendimento.caso_sugerido_id })
      .then(() => undefined, () => undefined)
  }

  await responder(contexto, 'Que bom que resolveu! Qualquer coisa, e so chamar aqui no grupo. 👍', true)

  return { acao: 'resolvido_pela_ia', atendimentoId: atendimento.id }
}

// ---------------------------------------------------------------------------
// Envio + registro
// ---------------------------------------------------------------------------

/**
 * Envia no mesmo chat de onde veio a mensagem e grava o envio.
 * Em grupo, cita a mensagem original e menciona quem pediu, para a resposta
 * nao se perder no meio da conversa.
 */
async function responder(contexto: Contexto, texto: string, porIA: boolean): Promise<boolean> {
  const supabase = criarClienteAdmin()
  const { atendimento, grupo, chatId, payload } = contexto

  const ehGrupo = Boolean(grupo)

  const resultado = await enviarTexto({
    destino: ehGrupo ? chatId : paraEnvio(atendimento.contato_numero),
    texto,
    citarMensagemId: ehGrupo ? (payload.messageId ?? null) : null,
    mencionar: ehGrupo ? [atendimento.contato_numero] : undefined,
  })

  if (!resultado.ok) {
    console.error('[fluxo] falha ao enviar mensagem:', resultado.erro)
    return false
  }

  await supabase.from('whatsapp_mensagens').insert({
    atendimento_id: atendimento.id,
    grupo_id: grupo?.id ?? null,
    direcao: 'enviada',
    tipo: 'texto',
    conteudo: texto,
    zapi_message_id: resultado.messageId,
    gerado_por_ia: porIA,
  })

  return true
}

// ---------------------------------------------------------------------------
// Auxiliares de banco
// ---------------------------------------------------------------------------

/**
 * Garante que o grupo tenha participantes sincronizados.
 *
 * Nao falha o fluxo se der errado: a lista serve para liberar mensagem
 * privada, e atendimento no grupo funciona sem ela.
 */
async function garantirParticipantes(grupo: Grupo): Promise<void> {
  const supabase = criarClienteAdmin()

  const { count } = await supabase
    .from('whatsapp_grupo_participantes')
    .select('id', { count: 'exact', head: true })
    .eq('grupo_id', grupo.id)

  if (count && count > 0) return

  const resultado = await sincronizarParticipantes(grupo)
  if (!resultado.ok) {
    console.error(`[fluxo] falha ao sincronizar participantes de ${grupo.nome}:`, resultado.erro)
  } else {
    console.log(`[fluxo] ${resultado.participantes} participantes sincronizados em ${grupo.nome}`)
  }
}

/** Busca o grupo; se for desconhecido, cadastra desativado para aparecer na UI. */
async function resolverGrupo(grupoIdZAPI: string, nome: string | null): Promise<Grupo | null> {
  const supabase = criarClienteAdmin()

  const { data } = await supabase
    .from('whatsapp_grupos')
    .select('*')
    .eq('grupo_id', grupoIdZAPI)
    .maybeSingle()

  if (data) return data as unknown as Grupo

  const { data: criado } = await supabase
    .from('whatsapp_grupos')
    .insert({
      grupo_id: grupoIdZAPI,
      nome: nome || `Grupo ${grupoIdZAPI.slice(0, 12)}`,
      ativo: false, // exige ativacao manual nas Configuracoes
      descricao: 'Detectado automaticamente. Ative para o bot atender este grupo.',
    })
    .select()
    .single()

  return (criado as unknown as Grupo) ?? null
}

interface OpcoesPrivado {
  numeroContato: string
  config: Config
  texto: string
  messageId: string | null
}

/**
 * Mensagem no privado. Como o suporte e centralizado nos grupos, o padrao e
 * responder pedindo que a pessoa escreva no grupo -- com limite de repeticao,
 * senao vira spam para quem insiste.
 */
async function tratarPrivado(opcoes: OpcoesPrivado): Promise<ResultadoProcessamento | null> {
  const { numeroContato, config } = opcoes
  const supabase = criarClienteAdmin()

  // O numero de alerta e o proprio operador falando com o sistema -- nao
  // faz sentido mandar ele "falar no grupo".
  if (config.numero_alerta && telefonesBatem(numeroContato, config.numero_alerta)) {
    return { acao: 'ignorado', detalhe: 'mensagem do proprio operador' }
  }

  // ---------------------------------------------------------------------
  // Porteiro: so quem participa de um grupo ATIVO interage pelo privado.
  //
  // Sem isto, qualquer pessoa que mandasse mensagem no numero -- parente,
  // cliente de outro assunto, numero desconhecido -- recebia resposta
  // automatica de suporte. O numero do WhatsApp e usado para outras coisas
  // alem desta ferramenta, e ela nao pode responder por ele.
  //
  // Consequencia intencional: sem nenhum grupo ativo, nenhuma mensagem
  // privada e respondida. Nao ha suporte acontecendo, entao nao ha a quem
  // responder.
  //
  // Retorna ANTES de a mensagem ser gravada: quem nao e do suporte nao vira
  // registro no painel.
  // ---------------------------------------------------------------------
  if (!(await participaDeGrupoAtivo(numeroContato))) {
    return {
      acao: 'privado_fora_do_escopo',
      detalhe: `${numeroContato} nao participa de nenhum grupo ativo`,
    }
  }

  // Desligado: segue o fluxo normal e abre chamado privado.
  if (!config.redirecionar_privado) return null

  const { data: aviso } = await supabase
    .from('whatsapp_avisos_privado')
    .select('*')
    .eq('numero', numeroContato)
    .maybeSingle()

  const avisadoRecentemente =
    aviso &&
    Date.now() - new Date((aviso as { avisado_em: string }).avisado_em).getTime() <
      config.privado_aviso_horas * 3600_000

  if (avisadoRecentemente) {
    return { acao: 'privado_ja_avisado', detalhe: numeroContato }
  }

  const resultado = await enviarTexto({
    destino: paraEnvio(numeroContato),
    texto: config.mensagem_privado,
  })

  await supabase.from('whatsapp_avisos_privado').upsert(
    {
      numero: numeroContato,
      avisado_em: new Date().toISOString(),
      vezes: ((aviso as { vezes?: number } | null)?.vezes ?? 0) + 1,
    },
    { onConflict: 'numero' },
  )

  return {
    acao: 'privado_redirecionado',
    detalhe: resultado.ok ? numeroContato : `falha no envio: ${resultado.erro}`,
  }
}

async function numeroIgnorado(numero: string): Promise<boolean> {
  const supabase = criarClienteAdmin()

  const { data } = await supabase.from('whatsapp_numeros_ignorados').select('numero').eq('ativo', true)
  if (!data?.length) return false

  // Comparacao por sufixo, nunca por igualdade -- o numero do payload vem com
  // DDI e o cadastrado a mao frequentemente nao vem.
  return (data as unknown as { numero: string }[]).some((linha) =>
    telefonesBatem(numero, linha.numero),
  )
}

async function buscarChamadoVivo(
  grupoId: string | null,
  numeroContato: string,
): Promise<Atendimento | null> {
  const supabase = criarClienteAdmin()

  let consulta = supabase
    .from('whatsapp_atendimentos')
    .select('*')
    .eq('contato_numero', numeroContato)
    .in('status', ['aberto', 'em_andamento', 'aguardando_cliente'])
    .order('ultima_mensagem_em', { ascending: false })
    .limit(1)

  consulta = grupoId ? consulta.eq('grupo_id', grupoId) : consulta.is('grupo_id', null)

  const { data } = await consulta
  return ((data?.[0] as unknown as Atendimento) ?? null) || null
}

interface OpcoesCriarChamado {
  grupo: Grupo | null
  numeroContato: string
  nomeContato: string | null
  urgencia: 'baixa' | 'normal' | 'alta'
  resumo: string
}

async function criarChamado(opcoes: OpcoesCriarChamado): Promise<Atendimento | null> {
  const supabase = criarClienteAdmin()
  const { grupo, numeroContato, nomeContato, urgencia } = opcoes

  const { data, error } = await supabase
    .from('whatsapp_atendimentos')
    .insert({
      origem: grupo ? 'grupo' : 'privado',
      grupo_id: grupo?.id ?? null,
      contato_numero: numeroContato,
      contato_nome: nomeContato,
      status: 'aberto',
      prioridade: urgencia === 'alta' ? 'alta' : urgencia === 'baixa' ? 'baixa' : 'normal',
      ultima_mensagem_em: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    // Corrida com outro evento do mesmo participante: o unique index de
    // chamado vivo barrou. Basta buscar o que o vencedor criou.
    if (error.code === '23505') return buscarChamadoVivo(grupo?.id ?? null, numeroContato)
    console.error('[fluxo] falha ao criar chamado:', error.message)
    return null
  }

  return data as unknown as Atendimento
}

/** Anexa a mensagem a um chamado vivo, quando a automacao foi pulada. */
async function vincularAChamadoExistente(
  mensagemId: string,
  grupo: Grupo | null,
  numeroContato: string,
): Promise<void> {
  const supabase = criarClienteAdmin()
  const chamado = await buscarChamadoVivo(grupo?.id ?? null, numeroContato)
  if (!chamado) return

  await supabase
    .from('whatsapp_mensagens')
    .update({ atendimento_id: chamado.id })
    .eq('id', mensagemId)

  await supabase
    .from('whatsapp_atendimentos')
    .update({ ultima_mensagem_em: new Date().toISOString() })
    .eq('id', chamado.id)
}

async function ultimaRespostaDoBot(atendimentoId: string): Promise<string | null> {
  const supabase = criarClienteAdmin()

  const { data } = await supabase
    .from('whatsapp_mensagens')
    .select('conteudo')
    .eq('atendimento_id', atendimentoId)
    .eq('direcao', 'enviada')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return ((data as { conteudo?: string } | null)?.conteudo) ?? null
}

async function respondeuRecentemente(atendimentoId: string, minutos: number): Promise<boolean> {
  const supabase = criarClienteAdmin()
  const limite = new Date(Date.now() - minutos * 60_000).toISOString()

  const { data } = await supabase
    .from('whatsapp_mensagens')
    .select('id')
    .eq('atendimento_id', atendimentoId)
    .eq('direcao', 'enviada')
    .eq('gerado_por_ia', true)
    .gte('created_at', limite)
    .limit(1)

  return Boolean(data?.length)
}
