// Janela de atendimento humano, avaliada no fuso configurado no grupo.
//
// O servidor pode rodar em UTC (Vercel roda), entao nunca use a hora local do
// processo -- sempre projete a data para o timezone do grupo.

import type { Grupo } from '@/lib/tipos'

const DIAS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

interface MomentoLocal {
  diaSemana: number
  minutos: number
  hhmm: string
}

/** Projeta um instante no fuso informado e devolve dia da semana + minutos. */
export function momentoNoFuso(data: Date, timezone: string): MomentoLocal {
  let partes: Intl.DateTimeFormatPart[]
  try {
    partes = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(data)
  } catch {
    // Timezone invalido no cadastro nao pode derrubar o webhook.
    partes = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(data)
  }

  const buscar = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? ''

  // 'hour12: false' devolve 24 em vez de 00 a meia-noite em alguns runtimes.
  const hora = Number(buscar('hour')) % 24
  const minuto = Number(buscar('minute'))

  return {
    diaSemana: DIAS[buscar('weekday')] ?? 0,
    minutos: hora * 60 + minuto,
    hhmm: `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`,
  }
}

/** Converte 'HH:MM' ou 'HH:MM:SS' em minutos desde a meia-noite. */
function paraMinutos(hora: string): number {
  const [h, m] = hora.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** O grupo esta dentro da janela de atendimento humano agora? */
export function dentroDoHorario(grupo: Grupo, agora: Date = new Date()): boolean {
  if (grupo.atendimento_24h) return true

  const { diaSemana, minutos } = momentoNoFuso(agora, grupo.timezone)

  const dias = grupo.dias_semana?.length ? grupo.dias_semana : [0, 1, 2, 3, 4, 5, 6]
  if (!dias.includes(diaSemana)) return false

  const inicio = paraMinutos(grupo.horario_inicio)
  const fim = paraMinutos(grupo.horario_fim)

  // Janela que cruza a meia-noite (ex: 22:00 as 06:00).
  if (fim < inicio) return minutos >= inicio || minutos < fim

  return minutos >= inicio && minutos < fim
}

/**
 * Proximo instante em que a janela abre. Usado para agendar o alerta gerado
 * fora do horario, em vez de acordar o atendente as 3 da manha.
 */
export function proximaAbertura(grupo: Grupo, agora: Date = new Date()): Date {
  if (grupo.atendimento_24h) return agora

  const inicioMin = paraMinutos(grupo.horario_inicio)
  const dias = grupo.dias_semana?.length ? grupo.dias_semana : [0, 1, 2, 3, 4, 5, 6]

  // Anda de 30 em 30 minutos ate achar a abertura. Grosseiro, mas roda no
  // maximo ~336 iteracoes (7 dias) e evita reimplementar aritmetica de fuso.
  for (let passo = 0; passo <= 7 * 48; passo++) {
    const candidato = new Date(agora.getTime() + passo * 30 * 60 * 1000)
    const { diaSemana, minutos } = momentoNoFuso(candidato, grupo.timezone)
    if (dias.includes(diaSemana) && minutos >= inicioMin && dentroDoHorario(grupo, candidato)) {
      return candidato
    }
  }

  return agora
}

/** Substitui {{horario_inicio}} / {{horario_fim}} na mensagem do grupo. */
export function aplicarVariaveisHorario(texto: string, grupo: Grupo): string {
  return texto
    .replace(/\{\{horario_inicio\}\}/g, grupo.horario_inicio.slice(0, 5))
    .replace(/\{\{horario_fim\}\}/g, grupo.horario_fim.slice(0, 5))
}
