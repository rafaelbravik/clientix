/** Valida e preserva o literal bytea devolvido por `fn_encrypt_oauth`. */
export function sessionCiphertextForDatabase(ciphertext: string): string | null {
  return /^\\x(?:[a-f0-9]{2})+$/i.test(ciphertext) ? ciphertext : null;
}
