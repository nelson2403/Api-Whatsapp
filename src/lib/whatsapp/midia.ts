// Rehospedagem de midia.
//
// A URL que o Z-API manda para imagem, video, audio e documento aponta para
// um storage temporario e EXPIRA. Guardar so ela significa que, dias depois,
// o atendente abre um chamado antigo e ve imagem quebrada -- justamente
// quando o historico importa mais, na hora de entender o que ja aconteceu.
//
// Entao o arquivo e baixado e regravado no Storage do Supabase no momento do
// recebimento. A URL original fica gravada a parte, como registro do que
// chegou.

import { criarClienteAdmin } from '@/lib/supabase/admin'

const BUCKET = 'midias'

// Teto por arquivo. Video de WhatsApp costuma ficar bem abaixo disso; o
// limite existe para um envio gigante nao estourar o tempo do webhook.
const TAMANHO_MAXIMO = 25 * 1024 * 1024

const EXTENSOES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
}

export interface MidiaRehospedada {
  url: string | null
  urlOriginal: string
  nome: string | null
  mimeType: string | null
  erro: string | null
}

function extensaoDe(mimeType: string | null, nomeOriginal?: string | null): string {
  if (mimeType && EXTENSOES[mimeType]) return EXTENSOES[mimeType]

  const doNome = nomeOriginal?.split('.').pop()?.toLowerCase()
  if (doNome && /^[a-z0-9]{2,5}$/.test(doNome)) return doNome

  if (mimeType?.startsWith('image/')) return 'jpg'
  if (mimeType?.startsWith('video/')) return 'mp4'
  if (mimeType?.startsWith('audio/')) return 'ogg'

  return 'bin'
}

/**
 * Baixa a midia do Z-API e regrava no Storage.
 *
 * Nunca lanca: se falhar, devolve `url: null` e o fluxo segue com a URL
 * original. Perder a imagem e ruim; perder a mensagem inteira e pior.
 */
export async function rehospedarMidia(
  urlOriginal: string,
  opcoes: { mimeType?: string | null; nome?: string | null; prefixo?: string } = {},
): Promise<MidiaRehospedada> {
  const resultado: MidiaRehospedada = {
    url: null,
    urlOriginal,
    nome: opcoes.nome ?? null,
    mimeType: opcoes.mimeType ?? null,
    erro: null,
  }

  if (!urlOriginal) {
    resultado.erro = 'URL vazia'
    return resultado
  }

  try {
    const resposta = await fetch(urlOriginal, { signal: AbortSignal.timeout(25_000) })

    if (!resposta.ok) {
      resultado.erro = `Download falhou: HTTP ${resposta.status}`
      return resultado
    }

    const tamanhoDeclarado = Number(resposta.headers.get('content-length') ?? 0)
    if (tamanhoDeclarado > TAMANHO_MAXIMO) {
      resultado.erro = `Arquivo grande demais (${Math.round(tamanhoDeclarado / 1024 / 1024)} MB)`
      return resultado
    }

    const buffer = Buffer.from(await resposta.arrayBuffer())

    if (buffer.length > TAMANHO_MAXIMO) {
      resultado.erro = `Arquivo grande demais (${Math.round(buffer.length / 1024 / 1024)} MB)`
      return resultado
    }

    const mimeType =
      opcoes.mimeType || resposta.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'

    resultado.mimeType = mimeType

    const extensao = extensaoDe(mimeType, opcoes.nome)
    const pasta = opcoes.prefixo ?? 'recebidas'
    const caminho = `${pasta}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extensao}`

    const supabase = criarClienteAdmin()

    const { error } = await supabase.storage.from(BUCKET).upload(caminho, buffer, {
      contentType: mimeType,
      // Nome unico por upload; nao ha o que sobrescrever.
      upsert: false,
    })

    if (error) {
      resultado.erro = `Upload falhou: ${error.message}`
      return resultado
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(caminho)
    resultado.url = data.publicUrl

    return resultado
  } catch (e) {
    resultado.erro = e instanceof Error ? e.message : 'Falha desconhecida ao rehospedar'
    return resultado
  }
}

/**
 * URL que o modelo de visao deve receber.
 *
 * Prefere a copia rehospedada: a original do Z-API pode ja ter expirado, e
 * alguns hosts bloqueiam hotlink e devolvem 403 para a Groq.
 */
export function urlParaVisao(midiaUrl: string | null, urlOriginal: string | null): string | null {
  return midiaUrl ?? urlOriginal ?? null
}
