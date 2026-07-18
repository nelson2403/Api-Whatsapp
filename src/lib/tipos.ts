// Tipos compartilhados entre servidor e cliente.

export type StatusAtendimento =
  | 'aberto'
  | 'em_andamento'
  | 'aguardando_cliente'
  | 'resolvido'
  | 'encerrado'

export type OrigemAtendimento = 'grupo' | 'privado'
export type DirecaoMensagem = 'recebida' | 'enviada'
export type TipoMensagem = 'texto' | 'imagem' | 'audio' | 'documento' | 'outro'
export type Papel = 'admin' | 'atendente'

export interface Config {
  id: number
  bot_ativo: boolean
  ia_ativa: boolean
  ia_classificacao_ativa: boolean
  max_tentativas_ia: number
  alerta_ativo: boolean
  numero_alerta: string | null
  redirecionar_privado: boolean
  mensagem_privado: string
  privado_aviso_horas: number
}

export interface Grupo {
  id: string
  grupo_id: string
  nome: string
  descricao: string | null
  ativo: boolean
  atendimento_24h: boolean
  horario_inicio: string
  horario_fim: string
  dias_semana: number[]
  timezone: string
  mensagem_fora_horario: string
  anti_flood_minutos: number
}

export interface Atendimento {
  id: string
  origem: OrigemAtendimento
  grupo_id: string | null
  contato_numero: string
  contato_nome: string | null
  status: StatusAtendimento
  categoria: string | null
  prioridade: 'baixa' | 'normal' | 'alta'
  usuario_id: string | null
  assumido_em: string | null
  ia_tentativas: number
  ia_escalado: boolean
  escalado_em: string | null
  motivo_escalonamento: string | null
  caso_sugerido_id: string | null
  resolvido_por: 'ia' | 'humano' | null
  resolvido_em: string | null
  primeira_resposta_em: string | null
  ultima_mensagem_em: string
  created_at: string
}

export interface Mensagem {
  id: string
  atendimento_id: string | null
  grupo_id: string | null
  direcao: DirecaoMensagem
  tipo: TipoMensagem
  conteudo: string | null
  remetente_numero: string | null
  remetente_nome: string | null
  zapi_message_id: string | null
  gerado_por_ia: boolean
  enviado_por: string | null
  raw: Record<string, unknown> | null
  created_at: string
}

export interface CasoConhecimento {
  id: string
  titulo: string
  categoria: string | null
  sintomas: string[]
  causa: string | null
  passos: string[]
  observacao: string | null
  escalar_direto: boolean
  prioridade: number
  ativo: boolean
  vezes_usado: number
  vezes_resolveu: number
}

export interface Alerta {
  id: string
  atendimento_id: string
  titulo: string
  detalhe: string | null
  urgencia: 'normal' | 'alta'
  agendado_para: string
  whatsapp_enviado_em: string | null
  lido_em: string | null
  created_at: string
}

export interface Perfil {
  id: string
  nome: string
  email: string | null
  telefone: string | null
  papel: Papel
  ativo: boolean
}

// --- Payload do webhook Z-API -------------------------------------------
// Apenas os campos que o fluxo consome. O Z-API manda bem mais que isso, e
// o objeto inteiro fica salvo em whatsapp_mensagens.raw.
export interface PayloadZAPI {
  /** Em conversa privada e o numero. Em grupo e o ID do grupo. */
  phone?: string
  /** Em grupo, o numero de quem realmente enviou. Ausente no privado. */
  participantPhone?: string
  fromMe?: boolean
  isGroup?: boolean
  senderName?: string
  chatName?: string
  messageId?: string
  momment?: number
  text?: { message?: string }
  message?: string
  image?: { imageUrl?: string; caption?: string; mimeType?: string }
  audio?: { audioUrl?: string; mimeType?: string }
  document?: { documentUrl?: string; fileName?: string; mimeType?: string }
  [k: string]: unknown
}
