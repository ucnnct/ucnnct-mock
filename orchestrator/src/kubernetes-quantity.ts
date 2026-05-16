const MEBIBYTE = 1024 * 1024;

export function percentOrZero(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 100);
}

export function parseCpuToMillicores(raw: string | undefined): number {
  const quantity = parseQuantity(raw);
  if (!quantity) {
    return 0;
  }

  switch (quantity.suffix) {
    case 'n':
      return quantity.amount / 1_000_000;
    case 'u':
      return quantity.amount / 1_000;
    case 'm':
      return quantity.amount;
    default:
      return quantity.amount * 1_000;
  }
}

export function parseMemoryToMi(raw: string | undefined): number {
  const quantity = parseQuantity(raw);
  if (!quantity) {
    return 0;
  }

  const factor = MEMORY_FACTORS_TO_MI[quantity.suffix] ?? 1 / MEBIBYTE;
  return quantity.amount * factor;
}

const MEMORY_FACTORS_TO_MI: Record<string, number> = {
  Ki: 1 / 1024,
  Mi: 1,
  Gi: 1024,
  Ti: 1024 * 1024,
  Pi: 1024 * 1024 * 1024,
  Ei: 1024 * 1024 * 1024 * 1024,
  n: 1 / 1_000_000_000 / MEBIBYTE,
  u: 1 / 1_000_000 / MEBIBYTE,
  m: 1 / 1_000 / MEBIBYTE,
  K: 1_000 / MEBIBYTE,
  M: 1_000_000 / MEBIBYTE,
  G: 1_000_000_000 / MEBIBYTE,
  T: 1_000_000_000_000 / MEBIBYTE,
  P: 1_000_000_000_000_000 / MEBIBYTE,
  E: 1_000_000_000_000_000_000 / MEBIBYTE
};

function parseQuantity(raw: string | undefined): { amount: number; suffix: string } | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }

  const match = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)?$/.exec(value);
  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1] ?? '0');
  if (!Number.isFinite(amount)) {
    return null;
  }

  return {
    amount,
    suffix: match[2] ?? ''
  };
}
