// Estado das integracoes externas, medido de dentro do servidor.
//
// Existe porque as duas dependencias externas falham de formas silenciosas:
//
//   Z-API  -- o pareamento por QR cai sozinho (celular sem bateria, WhatsApp
//             Web deslogado em outro lugar, plano vencido). Quando cai, o
//             webhook simplesmente para de receber, sem erro em lugar nenhum.
//   Groq   -- quando a chamada falha, o fluxo escala o chamado (correto), mas
//             o motivo fica so no campo do atendimento. Sem um teste direto,
//             nao da para distinguir "chave errada" de "rede bloqueada" de
//             "modelo removido".
//
// Rodar o teste daqui importa: o que vale e se o SERVIDOR alcanca o servico,
// nao se a maquina de quem esta depurando alcanca.

import { NextResponse } from 'next/server'
import { criarClienteServidor } from '@/lib/supabase/server'
import { statusInstancia, zapiConfigurado } from '@/lib/whatsapp/zapi'

export const dynamic = 'force-dynamic'

interface DiagnosticoIA {
  configurada: boolean
  alcancavel: boolean
  modelo: string | null
  latenciaMs: number | null
  erro: string | null
}

async function testarGroq(): Promise<DiagnosticoIA> {
  const chave = process.env.GROQ_API_KEY
  const modelo = process.env.GROQ_MODEL_CLASSIFICACAO || 'llama-3.1-8b-instant'

  if (!chave) {
    return {
      configurada: false,
      alcancavel: false,
      modelo: null,
      latenciaMs: null,
      erro: 'GROQ_API_KEY ausente. Todo chamado vai direto para atendente humano.',
    }
  }

  const inicio = Date.now()

  try {
    // Chamada minima de verdade -- 1 token. Testar o /models nao serve:
    // ele pode responder enquanto a inferencia esta indisponivel.
    const resposta = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${chave}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelo,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: AbortSignal.timeout(12_000),
    })

    const latenciaMs = Date.now() - inicio

    if (!resposta.ok) {
      const corpo = (await resposta.json().catch(() => ({}))) as {
        error?: { message?: string; code?: string }
      }
      return {
        configurada: true,
        alcancavel: false,
        modelo,
        latenciaMs,
        erro:
          corpo.error?.message ??
          `HTTP ${resposta.status}` +
            (resposta.status === 401
              ? ' -- chave invalida ou revogada'
              : resposta.status === 429
                ? ' -- limite de uso atingido'
                : ''),
      }
    }

    return { configurada: true, alcancavel: true, modelo, latenciaMs, erro: null }
  } catch (e) {
    const erro = e instanceof Error ? e.message : 'falha desconhecida'
    return {
      configurada: true,
      alcancavel: false,
      modelo,
      latenciaMs: Date.now() - inicio,
      erro:
        erro.includes('timeout') || erro.includes('aborted')
          ? `Tempo esgotado (${Date.now() - inicio}ms) -- o servidor nao alcancou a API da Groq`
          : erro,
    }
  }
}

export async function GET() {
  const supabase = await criarClienteServidor()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ erro: 'Nao autenticado' }, { status: 401 })

  const [zapi, ia] = await Promise.all([
    zapiConfigurado()
      ? statusInstancia()
      : Promise.resolve({ conectado: false, sessaoIniciada: false, erro: 'Z-API nao configurado' }),
    testarGroq(),
  ])

  return NextResponse.json({
    zapi,
    ia: ia.alcancavel,
    diagnosticoIA: ia,
  })
}
