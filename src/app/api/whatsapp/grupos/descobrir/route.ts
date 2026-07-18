// Lista os grupos do WhatsApp da instancia conectada.
//
// Sem isto, cadastrar um grupo dependia de mandar uma mensagem nele e esperar
// aparecer sozinho -- funciona, mas e um caminho torto para quem so quer
// escolher entre os grupos que ja tem.
//
// Rota de servidor porque precisa do token do Z-API.

import { NextResponse } from 'next/server'
import { criarClienteServidor } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

interface ChatZAPI {
  phone?: string
  name?: string
  isGroup?: boolean
  archived?: string
  lastMessageTime?: string
}

export interface GrupoDescoberto {
  grupoId: string
  nome: string
  arquivado: boolean
  ultimaMensagemEm: string | null
  /** Ja existe em whatsapp_grupos. */
  jaCadastrado: boolean
  /** Cadastrado e com atendimento ligado. */
  ativo: boolean
}

export async function GET() {
  const supabase = await criarClienteServidor()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ erro: 'Nao autenticado' }, { status: 401 })

  const instancia = process.env.ZAPI_INSTANCE_ID
  const token = process.env.ZAPI_TOKEN
  const clientToken = process.env.ZAPI_CLIENT_TOKEN

  if (!instancia || !token) {
    return NextResponse.json({ erro: 'Z-API nao configurado' }, { status: 503 })
  }

  const base = `https://api.z-api.io/instances/${instancia}/token/${token}`
  const headers = clientToken ? { 'Client-Token': clientToken } : undefined

  // O endpoint pagina. Varre algumas paginas para nao perder grupo de quem
  // tem muita conversa, mas com teto para nao travar a requisicao.
  const chats: ChatZAPI[] = []
  const TAMANHO_PAGINA = 100
  const MAX_PAGINAS = 5

  try {
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const resposta = await fetch(
        `${base}/chats?page=${pagina}&pageSize=${TAMANHO_PAGINA}`,
        { headers, cache: 'no-store', signal: AbortSignal.timeout(15_000) },
      )

      if (!resposta.ok) {
        const corpo = (await resposta.json().catch(() => ({}))) as { error?: string }
        return NextResponse.json(
          { erro: corpo.error ?? `Z-API respondeu ${resposta.status}` },
          { status: 502 },
        )
      }

      const pagina_chats = (await resposta.json()) as ChatZAPI[]
      if (!Array.isArray(pagina_chats) || pagina_chats.length === 0) break

      chats.push(...pagina_chats)
      if (pagina_chats.length < TAMANHO_PAGINA) break
    }
  } catch (e) {
    return NextResponse.json(
      { erro: e instanceof Error ? e.message : 'Falha ao consultar o Z-API' },
      { status: 502 },
    )
  }

  // `isGroup` e o campo autoritativo. Nao deduza pelo formato do ID: grupos
  // antigos vem como 5528999861328-1608308507, sem o sufixo -group.
  const grupos = chats.filter((c) => c.isGroup === true && c.phone)

  const { data: cadastrados } = await supabase.from('whatsapp_grupos').select('grupo_id, ativo')

  const porId = new Map(
    ((cadastrados ?? []) as { grupo_id: string; ativo: boolean }[]).map((g) => [g.grupo_id, g]),
  )

  const resultado: GrupoDescoberto[] = grupos.map((g) => {
    const existente = porId.get(g.phone!)
    return {
      grupoId: g.phone!,
      nome: g.name?.trim() || 'Grupo sem nome',
      arquivado: g.archived === 'true',
      ultimaMensagemEm: g.lastMessageTime
        ? new Date(Number(g.lastMessageTime)).toISOString()
        : null,
      jaCadastrado: Boolean(existente),
      ativo: existente?.ativo ?? false,
    }
  })

  // Conversa mais recente primeiro -- o grupo de suporte ativo tende a estar
  // no topo, e e o que a pessoa esta procurando.
  resultado.sort((a, b) => (b.ultimaMensagemEm ?? '').localeCompare(a.ultimaMensagemEm ?? ''))

  return NextResponse.json({ grupos: resultado, totalChats: chats.length })
}
