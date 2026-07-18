// Sincronizacao dos participantes dos grupos.
//
// A lista serve a uma regra so, mas importante: quem NAO participa de um
// grupo ativo nao interage com a ferramenta pelo privado -- nao recebe o
// aviso de "fale no grupo" e nao abre chamado. Sem isso, qualquer pessoa que
// mandasse mensagem no numero recebia resposta automatica.

import { criarClienteAdmin } from '@/lib/supabase/admin'
import { normalizarTelefone } from '@/lib/whatsapp/telefone'
import type { Grupo } from '@/lib/tipos'

interface ParticipanteZAPI {
  phone?: string
  name?: string
  isAdmin?: boolean
  isSuperAdmin?: boolean
}

export interface ResultadoSincronizacao {
  ok: boolean
  grupo: string
  participantes: number
  erro: string | null
}

/**
 * Baixa a lista de participantes de um grupo no Z-API e substitui o que
 * estava gravado.
 */
export async function sincronizarParticipantes(grupo: Grupo): Promise<ResultadoSincronizacao> {
  const instancia = process.env.ZAPI_INSTANCE_ID
  const token = process.env.ZAPI_TOKEN
  const clientToken = process.env.ZAPI_CLIENT_TOKEN

  if (!instancia || !token) {
    return { ok: false, grupo: grupo.nome, participantes: 0, erro: 'Z-API nao configurado' }
  }

  const url = `https://api.z-api.io/instances/${instancia}/token/${token}/group-metadata/${grupo.grupo_id}`

  let participantes: ParticipanteZAPI[]

  try {
    const resposta = await fetch(url, {
      headers: clientToken ? { 'Client-Token': clientToken } : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })

    if (!resposta.ok) {
      const corpo = (await resposta.json().catch(() => ({}))) as { error?: string }
      return {
        ok: false,
        grupo: grupo.nome,
        participantes: 0,
        erro: corpo.error ?? `Z-API respondeu ${resposta.status}`,
      }
    }

    const dados = (await resposta.json()) as { participants?: ParticipanteZAPI[] }
    participantes = dados.participants ?? []
  } catch (e) {
    return {
      ok: false,
      grupo: grupo.nome,
      participantes: 0,
      erro: e instanceof Error ? e.message : 'Falha ao consultar o Z-API',
    }
  }

  const linhas = participantes
    .map((p) => ({
      grupo_id: grupo.id,
      numero: normalizarTelefone(p.phone),
      nome: p.name?.trim() || null,
      admin: p.isAdmin === true || p.isSuperAdmin === true,
      atualizado_em: new Date().toISOString(),
    }))
    .filter((p) => p.numero.length >= 8)

  const supabase = criarClienteAdmin()

  // Substitui em vez de acumular: quem saiu do grupo tem que sair da lista,
  // senao continua recebendo mensagem automatica para sempre.
  await supabase.from('whatsapp_grupo_participantes').delete().eq('grupo_id', grupo.id)

  if (linhas.length > 0) {
    // Em lotes: grupos grandes passam de 500 participantes e um insert unico
    // com tudo estoura o limite de payload.
    const TAMANHO_LOTE = 500

    for (let i = 0; i < linhas.length; i += TAMANHO_LOTE) {
      const lote = linhas.slice(i, i + TAMANHO_LOTE)
      const { error } = await supabase
        .from('whatsapp_grupo_participantes')
        .upsert(lote, { onConflict: 'grupo_id,numero' })

      if (error) {
        return { ok: false, grupo: grupo.nome, participantes: i, erro: error.message }
      }
    }
  }

  return { ok: true, grupo: grupo.nome, participantes: linhas.length, erro: null }
}

/** Sincroniza todos os grupos ativos. Usado pelo cron. */
export async function sincronizarGruposAtivos(): Promise<ResultadoSincronizacao[]> {
  const supabase = criarClienteAdmin()

  const { data } = await supabase.from('whatsapp_grupos').select('*').eq('ativo', true)
  const grupos = (data ?? []) as unknown as Grupo[]

  const resultados: ResultadoSincronizacao[] = []
  for (const grupo of grupos) {
    resultados.push(await sincronizarParticipantes(grupo))
  }

  return resultados
}

/**
 * O numero participa de algum grupo ativo?
 *
 * Em caso de falha devolve `false`: na duvida, nao mandar mensagem para
 * alguem que talvez nao tenha nada a ver com o suporte.
 */
export async function participaDeGrupoAtivo(numero: string): Promise<boolean> {
  const supabase = criarClienteAdmin()

  const { data, error } = await supabase.rpc('numero_em_grupo_ativo', { num: numero })

  if (error) {
    console.error('[participantes] falha ao verificar participacao:', error.message)
    return false
  }

  return data === true
}
