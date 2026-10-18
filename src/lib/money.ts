/** Pure currency formatting — safe for client and server bundles. */

export const CUR_SYMBOL: Record<string, string> = {
  USD: "$", INR: "₹", EUR: "€", GBP: "£", JPY: "¥", HKD: "HK$",
  CNY: "CN¥", KRW: "₩", AUD: "A$", CAD: "C$", SGD: "S$", TWD: "NT$",
  CHF: "CHF ", BRL: "R$", MXN: "MX$", SEK: "kr ", NOK: "kr ", DKK: "kr ",
};

/** currency-aware money render — "₹353.85", "$190.50", "EUR 12.30" */
export function fmtMoney(n: number, currency?: string): string {
  const c = (currency ?? "USD").toUpperCase();
  const sym = CUR_SYMBOL[c] ?? `${c} `;
  return `${sym}${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** compact money for market caps — "$3.08T", "₹2.1T" */
export function fmtMoneyCompact(n: number, currency?: string): string {
  const c = (currency ?? "USD").toUpperCase();
  const sym = CUR_SYMBOL[c] ?? `${c} `;
  const abs = Math.abs(n);
  const scaled = abs >= 1e12 ? n / 1e12 : abs >= 1e9 ? n / 1e9 : abs >= 1e6 ? n / 1e6 : n;
  const unit = abs >= 1e12 ? "T" : abs >= 1e9 ? "B" : abs >= 1e6 ? "M" : "";
  return `${sym}${scaled.toFixed(2)}${unit}`;
}
