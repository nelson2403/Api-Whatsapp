// Escalonamento: como um chamado sai do bot e chega no atendente.
//
// Dois canais, de proposito:
//
//   1. Linha em whatsapp_alertas. O painel escuta essa tabela via Realtime e
//      dispara o alarme sonoro no computador. So para quando alguem clica.
//   2. Mensagem no WhatsApp pessoal configurado em whatsapp_config.
//
// Um alerta gerado fora da janela de atendimento nao some: ele fica com
// `agendado_para` na proxima abertura, e o painel toca quando a janela abrir.
// Assim ninguem e acordado as 3 da manha e nada e esquecido.

import { criarClienteAdmin } from '@/lib/supabase/admin'
import { enviarTexto } from '@/lib/whatsapp/zapi'
import { paraEnvio, formatarTelefone } from '@/lib/whatsapp/telefone'
import { dentroDoHorario, proximaAbertura, momentoNoFuso } from '@/lib/whatsapp/horario'
import type { Atendimento, Config, Grupo } from '@/lib/tipos'

export interface OpcoesAlerta {
  atendimento: Atendimento
  grupo: Grupo | null
  config: Config
  motivo: string
  urgencia?: 'normal' | 'alta'
  /** Ultima mensagem do cliente, para dar contexto no alerta. */
  trechoProblema?: string | null
}

export async function dispararAlerta(opcoes: OpcoesAlerta): Promise<void> {
  const { atendimento, grupo, config, motivo, urgencia = 'normal', trechoProblema } = opcoes
  const supabase = criarClienteAdmin()

  const agora = new Date()
  const noHorario = grupo ? dentroDoHorario(grupo, agora) : true
  const agendadoPara = noHorario ? agora : grupo ? proximaAbertura(grupo, agora) : agora

  const quem = atendimento.contato_nome || formatarTelefone(atendimento.contato_numero)
  const onde = grupo?.nome ?? 'Mensagem privada'
  const titulo = `${quem} precisa de atendente - ${onde}`

  const detalhe = [
    trechoProblema ? `Problema: ${trechoProblema}` : null,
    `Motivo: ${motivo}`,
  ]
    .filter(Boolean)
    .join('\n')

  // 1. Registra o alerta. Isso e o que faz o alarme tocar no painel.
  const { data: alerta, error } = await supabase
    .from('whatsapp_alertas')
    .insert({
      atendimento_id: atendimento.id,
      titulo,
      detalhe,
      urgencia,
      agendado_para: agendadoPara.toISOString(),
    })
    .select()
    .single()

  if (error) {
    console.error('[alertas] falha ao registrar alerta:', error.message)
    return
  }

  // 2. WhatsApp no numero pessoal -- so dentro do horario. Fora dele, o
  //    alerta ja esta agendado e sera enviado quando a janela abrir.
  if (!config.alerta_ativo || !config.numero_alerta || !noHorario) return

  await enviarWhatsAppDeAlerta({
    alertaId: (alerta as { id: string }).id,
    numeroDestino: config.numero_alerta,
    quem,
    onde,
    trechoProblema,
    motivo,
    urgencia,
  })
}

interface OpcoesMensagemAlerta {
  alertaId: string
  numeroDestino: string
  quem: string
  onde: string
  trechoProblema?: string | null
  motivo: string
  urgencia: 'normal' | 'alta'
}

async function enviarWhatsAppDeAlerta(opcoes: OpcoesMensagemAlerta): Promise<void> {
  const { alertaId, numeroDestino, quem, onde, trechoProblema, motivo, urgencia } = opcoes
  const supabase = criarClienteAdmin()

  const urlPainel = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/atendimento`
    : null

  const texto = [
    urgencia === 'alta' ? '🚨 *ATENDIMENTO URGENTE*' : '🔔 *Atendimento precisa de voce*',
    '',
    `*Grupo:* ${onde}`,
    `*Contato:* ${quem}`,
    trechoProblema ? `*Problema:* ${trechoProblema}` : null,
    `*Motivo:* ${motivo}`,
    urlPainel ? `\nAbrir painel: ${urlPainel}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n')

  const resultado = await enviarTexto({ destino: paraEnvio(numeroDestino), texto })

  if (resultado.ok) {
    await supabase
      .from('whatsapp_alertas')
      .update({ whatsapp_enviado_em: new Date().toISOString() })
      .eq('id', alertaId)
  } else {
    // O alerta no painel ja existe; o WhatsApp e redundancia. Registrar e
    // seguir e melhor do que falhar o webhook inteiro por causa disso.
    console.error('[alertas] falha ao enviar WhatsApp de alerta:', resultado.erro)
  }
}

/**
 * Envia os alertas que ficaram pendentes fora do horario e cuja janela ja
 * abriu. Chamado pelo cron (rota /api/cron/alertas-pendentes).
 */
export async function enviarAlertasPendentes(): Promise<{ enviados: number }> {
  const supabase = criarClienteAdmin()

  const { data: config } = await supabase.from('whatsapp_config').select('*').eq('id', 1).single()
  const cfg = config as Config | null

  if (!cfg?.alerta_ativo || !cfg.numero_alerta) return { enviados: 0 }

  const { data: pendentes } = await supabase
    .from('whatsapp_alertas')
    .select('*, atendimento:whatsapp_atendimentos(contato_nome, contato_numero, grupo:whatsapp_grupos(nome))')
    .is('lido_em', null)
    .is('whatsapp_enviado_em', null)
    .lte('agendado_para', new Date().toISOString())
    .limit(20)

  if (!pendentes?.length) return { enviados: 0 }

  let enviados = 0
  for (const linha of pendentes as Array<Record<string, unknown>>) {
    const atendimento = linha.atendimento as
      | { contato_nome?: string; contato_numero?: string; grupo?: { nome?: string } }
      | null

    await enviarWhatsAppDeAlerta({
      alertaId: linha.id as string,
      numeroDestino: cfg.numero_alerta,
      quem: atendimento?.contato_nome || formatarTelefone(atendimento?.contato_numero) || 'Contato',
      onde: atendimento?.grupo?.nome ?? 'Mensagem privada',
      trechoProblema: null,
      motivo: (linha.detalhe as string) ?? 'Aguardando atendente desde fora do horario',
      urgencia: (linha.urgencia as 'normal' | 'alta') ?? 'normal',
    })
    enviados++
  }

  return { enviados }
}

/** Hora local do grupo, usada em mensagens ao cliente. */
export function horaLocalDoGrupo(grupo: Grupo): string {
  return momentoNoFuso(new Date(), grupo.timezone).hhmm
}
