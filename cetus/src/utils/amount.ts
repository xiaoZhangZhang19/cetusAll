export function toAtomicAmount(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.split('.');
  const normalizedFraction = `${fraction}${'0'.repeat(decimals)}`.slice(0, decimals);
  return BigInt(`${whole}${normalizedFraction}`);
}
