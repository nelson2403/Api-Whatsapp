// Reconhecimento do ID de acesso remoto na mensagem do cliente.
//
// Depois que a ferramenta pede o AnyDesk, o cliente responde com o numero.
// Extrair isso sozinho e o que faz o dado estar esperando no chamado quando o
// atendente abre, em vez de ele ter que garimpar na conversa.

/**
 * IDs de AnyDesk tem 9 ou 10 digitos. O cliente costuma mandar formatado
 * ("123 456 789"), as vezes com o rotulo junto ("anydesk 123456789").
 *
 * O risco aqui e o falso positivo: numero de telefone, CPF, valor, codigo de
 * nota. Por isso as regras sao restritivas -- e melhor nao reconhecer e o
 * atendente ler a conversa do que gravar um numero errado e ele tentar
 * conectar num ID que nao existe.
 */
export function extrairAcessoRemoto(
  texto: string,
  numeroDoContato?: string | null,
): string | null {
  if (!texto) return null

  const limpo = texto.trim()

  // Mensagem longa raramente e "so o ID". Se vier no meio de um texto grande,
  // exige o rotulo explicito para evitar pescar qualquer numero solto.
  const temRotulo = /any\s*desk|anydesk|acesso\s*remoto|\bid\b/i.test(limpo)
  if (limpo.length > 60 && !temRotulo) return null

  // Junta digitos separados por espaco/ponto/hifen, que e como o AnyDesk
  // mostra na tela e como as pessoas copiam.
  const candidatos = limpo.match(/\d[\d\s.\-]{7,14}\d/g)
  if (!candidatos) return null

  for (const bruto of candidatos) {
    const digitos = bruto.replace(/\D/g, '')

    // 9 ou 10 digitos. Telefone brasileiro com DDD tem 10 ou 11, entao ha
    // sobreposicao em 10 -- tratada logo abaixo.
    if (digitos.length < 9 || digitos.length > 10) continue

    // Nao confunde com o proprio numero de quem esta falando.
    if (numeroDoContato) {
      const doContato = numeroDoContato.replace(/\D/g, '')
      if (doContato.endsWith(digitos) || digitos.endsWith(doContato.slice(-8))) continue
    }

    // 10 digitos comecando com DDD valido e mais provavel ser telefone.
    // Sem o rotulo explicito, nao arrisca.
    if (digitos.length === 10 && !temRotulo && /^[1-9][1-9]9/.test(digitos)) continue

    return digitos
  }

  return null
}
