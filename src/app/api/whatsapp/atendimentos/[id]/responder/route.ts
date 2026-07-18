// Envio manual do atendente.
//
// Esta rota existe porque o token do Z-API e segredo de servidor e nao pode
// ir para o navegador. Todo o resto da UI (listar, assumir, encerrar) fala
// direto com o Supabase sob RLS -- nao ha ganho em espelhar isso em rotas.

import { NextResponse, type NextRequest } from 'next/server'
import { criarClienteServidor } from '@/lib/supabase/server'
import { enviarTexto } from '@/lib/whatsapp/zapi'
import { paraEnvio } from '@/lib/whatsapp/telefone'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, contexto: { params: Promise<{ id: string }> }) {
  const { id } = await contexto.params
  const supabase = await criarClienteServidor()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ erro: 'Nao autenticado' }, { status: 401 })

  const corpo = (await request.json().catch(() => ({}))) as { texto?: string }
  const texto = corpo.texto?.trim()

  if (!texto) return NextResponse.json({ erro: 'Texto vazio' }, { status: 400 })
  if (texto.length > 4000) {
    return NextResponse.json({ erro: 'Texto acima de 4000 caracteres' }, { status: 400 })
  }

  // A leitura passa por RLS: se o atendente nao pode ver o chamado, nao
  // consegue responder por ele.
  const { data: atendimento } = await supabase
    .from('whatsapp_atendimentos')
    .select('*, grupo:whatsapp_grupos(grupo_id)')
    .eq('id', id)
    .maybeSingle()

  if (!atendimento) return NextResponse.json({ erro: 'Atendimento nao encontrado' }, { status: 404 })

  const linha = atendimento as {
    id: string
    origem: string
    contato_numero: string
    primeira_resposta_em: string | null
    grupo: { grupo_id: string } | null
  }

  // Em grupo responde no grupo; no privado, direto para o contato.
  const destino =
    linha.origem === 'grupo' && linha.grupo?.grupo_id
      ? linha.grupo.grupo_id
      : paraEnvio(linha.contato_numero)

  const resultado = await enviarTexto({
    destino,
    texto,
    mencionar: linha.origem === 'grupo' ? [linha.contato_numero] : undefined,
  })

  if (!resultado.ok) {
    return NextResponse.json({ erro: resultado.erro ?? 'Falha no envio' }, { status: 502 })
  }

  await supabase.from('whatsapp_mensagens').insert({
    atendimento_id: id,
    grupo_id: null,
    direcao: 'enviada',
    tipo: 'texto',
    conteudo: texto,
    zapi_message_id: resultado.messageId,
    gerado_por_ia: false,
    enviado_por: user.id,
  })

  const agora = new Date().toISOString()
  await supabase
    .from('whatsapp_atendimentos')
    .update({
      ultima_mensagem_em: agora,
      status: 'em_andamento',
      // Atendente respondeu: o chamado e dele, e o bot para de responder.
      usuario_id: user.id,
      ...(linha.primeira_resposta_em ? {} : { primeira_resposta_em: agora }),
    })
    .eq('id', id)

  return NextResponse.json({ ok: true, messageId: resultado.messageId })
}
