// Normalizacao e comparacao de telefones.
//
// Numeros entram no sistema por caminhos diferentes -- digitados a mao no
// cadastro, vindos do payload do Z-API (sempre com DDI 55), colados de
// planilha -- e nenhum deles garante formato. Comparar por igualdade exata
// falha silenciosamente: era exatamente o bug que fazia a lista de numeros
// ignorados nunca funcionar na ferramenta anterior.
//
// Regra: sempre comparar por SUFIXO de digitos, nunca por igualdade.

/** Remove tudo que nao for digito. */
export function normalizarTelefone(valor: string | null | undefined): string {
  return (valor ?? '').replace(/\D/g, '')
}

/**
 * Dois numeros "batem" se os ultimos 11 digitos coincidem; cai para 10 e
 * depois 8 (fixo sem DDD, ultimo recurso) quando um dos lados e mais curto.
 * Isso absorve DDI 55 presente/ausente e o 9o digito presente/ausente.
 */
export function telefonesBatem(a: string, b: string): boolean {
  const x = normalizarTelefone(a)
  const y = normalizarTelefone(b)
  if (!x || !y) return false

  for (const tamanho of [11, 10, 8]) {
    if (x.length >= tamanho && y.length >= tamanho && x.slice(-tamanho) === y.slice(-tamanho)) {
      return true
    }
  }
  return false
}

/** O Z-API identifica grupos com o sufixo `-group` no campo `phone`. */
export function ehIdGrupo(phone: string | null | undefined): boolean {
  return typeof phone === 'string' && phone.includes('-group')
}

/** Formata para exibicao: 5527999998888 -> (27) 99999-8888 */
export function formatarTelefone(valor: string | null | undefined): string {
  const n = normalizarTelefone(valor)
  if (!n) return ''

  const semDDI = n.length > 11 && n.startsWith('55') ? n.slice(2) : n

  if (semDDI.length === 11) {
    return `(${semDDI.slice(0, 2)}) ${semDDI.slice(2, 7)}-${semDDI.slice(7)}`
  }
  if (semDDI.length === 10) {
    return `(${semDDI.slice(0, 2)}) ${semDDI.slice(2, 6)}-${semDDI.slice(6)}`
  }
  return valor ?? ''
}

/**
 * Formato aceito pelo Z-API no envio: so digitos, com DDI. Assume Brasil
 * quando o numero vem curto o bastante para nao ter DDI.
 */
export function paraEnvio(valor: string): string {
  const n = normalizarTelefone(valor)
  if (!n) return ''
  return n.length <= 11 ? `55${n}` : n
}
