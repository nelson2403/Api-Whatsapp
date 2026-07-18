// Casca das telas autenticadas.
//
// O alarme de escalonamento vive aqui, e nao dentro do painel de atendimento,
// para tocar em qualquer tela -- inclusive com o operador mexendo nas
// configuracoes ou na base de conhecimento.

import { redirect } from 'next/navigation'
import { usuarioAtual } from '@/lib/supabase/server'
import Nav from '@/components/Nav'
import AlarmeEscalonamento from '@/components/AlarmeEscalonamento'

export default async function LayoutPainel({ children }: { children: React.ReactNode }) {
  const sessao = await usuarioAtual()
  if (!sessao) redirect('/login')

  const nome = sessao.perfil?.nome || sessao.user.email || 'Atendente'

  return (
    <>
      <AlarmeEscalonamento />
      <Nav nome={nome} />
      {children}
    </>
  )
}
