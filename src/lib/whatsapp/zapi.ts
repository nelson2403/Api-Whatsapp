// Cliente Z-API.
//
// Todo envio passa por aqui. Nenhuma funcao lanca excecao: todas devolvem
// { ok, erro }. O webhook nao pode quebrar porque um envio falhou -- se ele
// devolver 500, o Z-API reenvia o evento e a mensagem e processada de novo.

const INSTANCE_ID = process.env.ZAPI_INSTANCE_ID
const TOKEN = process.env.ZAPI_TOKEN
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN

export interface RespostaEnvio {
  ok: boolean
  erro: string | null
  messageId: string | null
}

function baseUrl(): string | null {
  if (!INSTANCE_ID || !TOKEN) return null
  return `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}`
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    // O Client-Token vem do menu Seguranca da conta e e exigido alem do
    // token da instancia que ja esta na URL. Sem ele o Z-API devolve 401.
    ...(CLIENT_TOKEN ? { 'Client-Token': CLIENT_TOKEN } : {}),
  }
}

async function chamar(rota: string, corpo: unknown): Promise<RespostaEnvio> {
  const base = baseUrl()
  if (!base) {
    return { ok: false, erro: 'Z-API nao configurado (ZAPI_INSTANCE_ID / ZAPI_TOKEN)', messageId: null }
  }

  try {
    const resposta = await fetch(`${base}${rota}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(corpo),
      // Timeout curto: melhor falhar e escalar do que segurar o webhook.
      signal: AbortSignal.timeout(15_000),
    })

    const json = await resposta.json().catch(() => ({}) as Record<string, unknown>)

    if (!resposta.ok) {
      const erro =
        (json as { error?: string; message?: string })?.error ??
        (json as { message?: string })?.message ??
        `Erro HTTP ${resposta.status}`
      return { ok: false, erro, messageId: null }
    }

    const j = json as { messageId?: string; zaapId?: string; id?: string }
    return { ok: true, erro: null, messageId: j.messageId ?? j.zaapId ?? j.id ?? null }
  } catch (e) {
    const erro = e instanceof Error ? e.message : 'Falha de rede ao chamar o Z-API'
    return { ok: false, erro, messageId: null }
  }
}

export interface OpcoesTexto {
  /**
   * Destino. Numero com DDI e sem simbolos (5527999998888) para privado, ou
   * o ID do grupo (120363...-group) para grupo.
   */
  destino: string
  texto: string
  /** ID da mensagem original -- faz a resposta sair citando ela. */
  citarMensagemId?: string | null
  /** Numeros a mencionar (@). Usado para marcar quem pediu ajuda no grupo. */
  mencionar?: string[]
  /** Atraso em segundos antes do envio, deixa o bot menos robotico. */
  atrasoSegundos?: number
}

export async function enviarTexto(opcoes: OpcoesTexto): Promise<RespostaEnvio> {
  const { destino, texto, citarMensagemId, mencionar, atrasoSegundos } = opcoes

  if (!destino || !texto?.trim()) {
    return { ok: false, erro: 'Destino ou texto vazio', messageId: null }
  }

  return chamar('/send-text', {
    phone: destino,
    message: texto,
    ...(citarMensagemId ? { messageId: citarMensagemId } : {}),
    ...(mencionar?.length ? { mentioned: mencionar } : {}),
    ...(atrasoSegundos ? { delayMessage: atrasoSegundos } : {}),
  })
}

export async function enviarImagem(
  destino: string,
  urlImagem: string,
  legenda?: string,
): Promise<RespostaEnvio> {
  return chamar('/send-image', {
    phone: destino,
    image: urlImagem,
    ...(legenda ? { caption: legenda } : {}),
  })
}

export async function enviarDocumento(
  destino: string,
  urlDocumento: string,
  nomeArquivo: string,
): Promise<RespostaEnvio> {
  const extensao = nomeArquivo.split('.').pop()?.toLowerCase() || 'pdf'
  return chamar(`/send-document/${extensao}`, {
    phone: destino,
    document: urlDocumento,
    fileName: nomeArquivo,
  })
}

/** Marca a conversa como lida, para o contato nao ver "nao lida" acumulando. */
export async function marcarComoLida(destino: string, messageId: string): Promise<RespostaEnvio> {
  return chamar('/read-message', { phone: destino, messageId })
}

export interface StatusInstancia {
  conectado: boolean
  sessaoIniciada: boolean
  erro: string | null
}

/**
 * Estado da instancia. O pareamento por QR code cai sozinho (celular sem
 * bateria, WhatsApp Web deslogado, trial expirado) e, quando cai, tudo para
 * de funcionar em silencio. O painel consulta isso para avisar.
 */
export async function statusInstancia(): Promise<StatusInstancia> {
  const base = baseUrl()
  if (!base) return { conectado: false, sessaoIniciada: false, erro: 'Z-API nao configurado' }

  try {
    const resposta = await fetch(`${base}/status`, {
      headers: headers(),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    const json = (await resposta.json().catch(() => ({}))) as {
      connected?: boolean
      smartphoneConnected?: boolean
      error?: string
    }

    if (!resposta.ok) {
      return { conectado: false, sessaoIniciada: false, erro: json.error ?? `Erro HTTP ${resposta.status}` }
    }

    const conectado = json.connected === true

    return {
      conectado,
      sessaoIniciada: json.smartphoneConnected === true,
      // O Z-API preenche `error` mesmo quando deu tudo certo -- responde
      // "You are already connected." num 200 com connected:true. Repassar
      // isso faria o painel mostrar erro numa conexao saudavel.
      erro: conectado ? null : (json.error ?? null),
    }
  } catch (e) {
    return {
      conectado: false,
      sessaoIniciada: false,
      erro: e instanceof Error ? e.message : 'Falha ao consultar status',
    }
  }
}

export function zapiConfigurado(): boolean {
  return Boolean(INSTANCE_ID && TOKEN)
}
