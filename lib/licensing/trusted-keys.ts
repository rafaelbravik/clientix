/** Chaves públicas autorizadas a assinar licenças de produção. */
export const DEFAULT_TRUSTED_KEYS: Record<string, string> = {
  // Production license trust root. Public key only; private key remains outside the repository.
  "clientix-license-2026-01": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEABdvNnKrV2W9R1h047Ur/i8aovRQujYvxydKqjyxsIGI=\n-----END PUBLIC KEY-----",
};
