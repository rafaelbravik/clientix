# LIC-02C — detecção de clones e atestação de instalação

- Gera uma sessão efêmera por processo Clientix e adiciona heartbeat online configurável, sem validação por request.
- Vincula sessões à chave pública já registrada com desafio Ed25519 aleatório, nonce de uso único e expiração curta.
- Detecta sobreposição de sessões; exige heartbeat renovado de outra sessão para confirmar conflito persistente e evita confirmar boot antigo sem atividade simultânea.
- Restringe a licença por resposta online assinada quando o Control Plane confirma clone e preserva a tolerância offline quando o servidor está indisponível.
- Dá ao vendor uma ação de recuperação de uso único que encerra sessões e autoriza rotação local da chave; transferência, suspensão e revogação encerram sessões ativas.
- Mantém a chave privada da instalação local, mantém a chave privada de emissão exclusivamente no vendor e exclui as rotas centrais do build customer.
- Migration `control-plane/migrations/0003_installation_clone_attestation.sql` é somente do Control Plane; não foi aplicada ao banco self-hosted.
- Sem fingerprint de hardware, alterações em `deskcomm-crm`, produção, publicação ou push.
