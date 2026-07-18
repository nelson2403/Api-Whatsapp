// Despacha alertas que ficaram represados fora do horario de atendimento.
//
// Um chamado escalado as 23h nao acorda ninguem: o alerta e gravado com
// `agendado_para` na proxima abertura. Este cron roda de tempos em tempos,
// pega os que ja venceram e manda o WhatsApp.
//
// Na Vercel, agende em vercel.json. Em qualquer outro lugar, um cron comum
// chamando esta URL com o header Authorization resolve.

import { NextResponse, type NextRequest } from 'next/server'
import { enviarAlertasPendentes } from '@/lib/whatsapp/alertas'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const esperado = process.env.CRON_SECRET
  const recebido = request.headers.get('authorization')?.replace('Bearer ', '')

  if (!esperado || recebido !== esperado) {
    return NextResponse.json({ erro: 'Nao autorizado' }, { status: 401 })
  }

  try {
    const resultado = await enviarAlertasPendentes()
    return NextResponse.json({ ok: true, ...resultado })
  } catch (e) {
    console.error('[cron] falha ao despachar alertas:', e)
    return NextResponse.json({ ok: false, erro: 'Falha ao despachar alertas' }, { status: 500 })
  }
}
