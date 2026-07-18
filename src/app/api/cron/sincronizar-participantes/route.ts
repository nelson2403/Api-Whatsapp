// Mantem a lista de participantes em dia.
//
// Gente entra e sai dos grupos sem avisar. Quem saiu precisa parar de ser
// reconhecido no privado, e quem entrou precisa passar a ser -- senao a
// ferramenta responde para ex-participante e ignora participante novo ate
// alguem sincronizar na mao.

import { NextResponse, type NextRequest } from 'next/server'
import { sincronizarGruposAtivos } from '@/lib/whatsapp/participantes'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const esperado = process.env.CRON_SECRET
  const recebido = request.headers.get('authorization')?.replace('Bearer ', '')

  if (!esperado || recebido !== esperado) {
    return NextResponse.json({ erro: 'Nao autorizado' }, { status: 401 })
  }

  try {
    const resultados = await sincronizarGruposAtivos()
    console.log('[cron] participantes sincronizados:', JSON.stringify(resultados))
    return NextResponse.json({ ok: true, resultados })
  } catch (e) {
    console.error('[cron] falha ao sincronizar participantes:', e)
    return NextResponse.json({ ok: false, erro: 'Falha ao sincronizar' }, { status: 500 })
  }
}
