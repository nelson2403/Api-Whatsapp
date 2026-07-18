// Atualiza a lista de participantes dos grupos ativos.
//
// Chamada pela tela de Configuracoes. Rota de servidor porque precisa do
// token do Z-API.

import { NextResponse, type NextRequest } from 'next/server'
import { criarClienteServidor } from '@/lib/supabase/server'
import { criarClienteAdmin } from '@/lib/supabase/admin'
import { sincronizarParticipantes, sincronizarGruposAtivos } from '@/lib/whatsapp/participantes'
import type { Grupo } from '@/lib/tipos'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await criarClienteServidor()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ erro: 'Nao autenticado' }, { status: 401 })

  // A escrita e feita com a chave de servico, entao a checagem de papel
  // precisa ser explicita aqui -- o RLS nao vai barrar.
  const { data: perfil } = await supabase
    .from('whatsapp_perfis')
    .select('papel')
    .eq('id', user.id)
    .maybeSingle()

  if ((perfil as { papel?: string } | null)?.papel !== 'admin') {
    return NextResponse.json(
      { erro: 'Somente administradores podem sincronizar participantes' },
      { status: 403 },
    )
  }

  const corpo = (await request.json().catch(() => ({}))) as { grupoId?: string }

  if (corpo.grupoId) {
    const { data } = await criarClienteAdmin()
      .from('whatsapp_grupos')
      .select('*')
      .eq('id', corpo.grupoId)
      .maybeSingle()

    if (!data) return NextResponse.json({ erro: 'Grupo nao encontrado' }, { status: 404 })

    const resultado = await sincronizarParticipantes(data as unknown as Grupo)
    return NextResponse.json({ resultados: [resultado] })
  }

  return NextResponse.json({ resultados: await sincronizarGruposAtivos() })
}
