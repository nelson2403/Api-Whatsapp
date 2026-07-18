// Webhook do Z-API -- porta de entrada de todas as mensagens.
//
// Rota publica (o Z-API nao tem sessao), autenticada pelo segredo no caminho.
// Precisa estar na allowlist do middleware, veja src/middleware.ts.
//
// Regra de ouro: SEMPRE devolver 200, mesmo em erro interno. O Z-API reenvia
// eventos que nao receberam 200, e reprocessar significa mandar a mesma
// resposta duas vezes para o cliente. Erro fica no log, nao no status.

import { NextResponse, type NextRequest } from 'next/server'
import { processarMensagem } from '@/lib/whatsapp/fluxo'
import type { PayloadZAPI } from '@/lib/tipos'

// O fluxo chama a IA e o Z-API -- pode passar do limite padrao.
export const maxDuration = 60
export const dynamic = 'force-dynamic'

function segredoConfere(recebido: string): boolean {
  const esperado = process.env.ZAPI_WEBHOOK_SECRET
  if (!esperado) return false
  if (recebido.length !== esperado.length) return false

  // Comparacao de tempo constante. Exagero? Talvez. Mas custa 3 linhas e
  // fecha a porta para descobrir o segredo medindo tempo de resposta.
  let diferenca = 0
  for (let i = 0; i < esperado.length; i++) {
    diferenca |= recebido.charCodeAt(i) ^ esperado.charCodeAt(i)
  }
  return diferenca === 0
}

export async function POST(
  request: NextRequest,
  contexto: { params: Promise<{ secret: string }> },
) {
  const { secret } = await contexto.params

  if (!segredoConfere(secret)) {
    // Aqui sim 404: nao vaza que a rota existe.
    return NextResponse.json({ erro: 'Nao encontrado' }, { status: 404 })
  }

  let payload: PayloadZAPI
  try {
    payload = (await request.json()) as PayloadZAPI
  } catch {
    return NextResponse.json({ ok: true, acao: 'payload_invalido' })
  }

  try {
    const resultado = await processarMensagem(payload)

    console.log('[webhook]', JSON.stringify({
      acao: resultado.acao,
      detalhe: resultado.detalhe,
      atendimento: resultado.atendimentoId,
      grupo: payload.isGroup ? payload.chatName : null,
      de: payload.participantPhone ?? payload.phone,
    }))

    return NextResponse.json({ ok: true, ...resultado })
  } catch (e) {
    // Nunca propague: 500 faz o Z-API reenviar e duplicar a resposta.
    console.error('[webhook] erro nao tratado:', e)
    return NextResponse.json({ ok: true, acao: 'erro_interno' })
  }
}

/** GET simples para conferir no navegador se o segredo e a rota estao certos. */
export async function GET(
  _request: NextRequest,
  contexto: { params: Promise<{ secret: string }> },
) {
  const { secret } = await contexto.params
  if (!segredoConfere(secret)) {
    return NextResponse.json({ erro: 'Nao encontrado' }, { status: 404 })
  }
  return NextResponse.json({
    ok: true,
    mensagem: 'Webhook ativo. Configure esta mesma URL em "Ao receber" no painel do Z-API.',
  })
}
