import { redirect } from 'next/navigation'
import { usuarioAtual } from '@/lib/supabase/server'
import PainelAtendimentos from '@/components/PainelAtendimentos'
import type { Perfil } from '@/lib/tipos'

export const dynamic = 'force-dynamic'

export default async function PaginaAtendimento() {
  const sessao = await usuarioAtual()
  if (!sessao) redirect('/login')

  // O perfil e criado por trigger no primeiro login. Se ainda nao existir
  // (trigger nao instalado, usuario criado antes da migration), monta um
  // objeto minimo para a tela nao quebrar.
  const perfil: Perfil = (sessao.perfil as Perfil | null) ?? {
    id: sessao.user.id,
    nome: sessao.user.email ?? 'Atendente',
    email: sessao.user.email ?? null,
    telefone: null,
    papel: 'atendente',
    ativo: true,
  }

  return <PainelAtendimentos perfil={perfil} />
}
