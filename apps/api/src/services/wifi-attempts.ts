/**
 * Quando o portal mandou a última troca de Wi-Fi de cada cliente, em memória (reiniciar a API zera).
 * Serve para só aceitar o registro da Wiki que é DESTA tentativa: sem isso, uma troca antiga "aplicada" passaria por
 * resultado de uma nova que ainda nem terminou.
 */
export const wifiAttemptAt = new Map<string, number>();
