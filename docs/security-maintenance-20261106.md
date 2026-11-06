# Segurança dos componentes web — 06/11/2026

## TronSoftOS 0.1.140

O proxy TronComanda passa de `nginx:1.27-alpine` para
`nginx:1.30.6-alpine`, versão estável que inclui as correções divulgadas em
14/10/2026. A configuração de rotas, os volumes, as portas e as branches dos
aplicativos não são modificados. O Debian 11 e o Firebird permanecem inalterados.

Referências oficiais:

- https://nginx.org/en/security_advisories.html
- https://nginx.org/news.html
- https://nextjs.org/blog/november-2026-security-release
- https://nodejs.org/en/blog/vulnerability/november-2026-security-releases

## Aplicação

Atualizar o código do TronSoftOS disponibiliza o novo compose. A correção do
proxy só entra em execução quando o serviço `web` for recriado com a nova
imagem: atualizar apenas o código ou reiniciar o container antigo não basta.
Planejar a breve interrupção do proxy web; ela não exige reiniciar o Firebird.

No diretório `/opt/tronsoftos/apps/troncomanda`, preservar a imagem atual e as
configurações antes da troca. Usar as credenciais Docker já configuradas no
TronSoftOS. Aplicação direcionada:

```sh
docker tag "$(docker inspect troncomanda_web --format '{{.Image}}')" troncomanda-web:before-security-update
DOCKER_CONFIG=/opt/tronsoftos/state/docker-config docker compose -p troncomanda pull web
DOCKER_CONFIG=/opt/tronsoftos/state/docker-config docker compose -p troncomanda up -d --no-deps web
docker exec troncomanda_web nginx -t
docker exec troncomanda_web nginx -v
```

Validar redirecionamentos, recursos estáticos e comunicação pelos caminhos
`/qr/`, `/api/`, `/kds/`, `/cardapio/`, `/gerente/` e `/retaguarda/`, conforme
os aplicativos habilitados. Conferir PIDs do Firebird e IDs dos demais
containers antes/depois. Se houver falha, retornar à imagem anterior usando
um override temporário exclusivo do serviço `web`; preservar o compose e
as configurações originais. Não executar `down` no conjunto de aplicativos.

## Correções separadas

- As imagens de Gerente e Retaguarda Web são mantidas em outros repositórios.
  Correções de Next.js, React, sharp e Node nessas imagens exigem atualização
  dos fontes, lockfile e rebuild do aplicativo. Não instalar pacotes novos
  sobre o diretório `.next` já compilado de uma imagem standalone.
- O boletim Next.js de 03/11 anuncia versões 15.5.29 e 16.4.5. Conferir os
  intervalos afetados e as funções usadas em cada aplicativo; uma versão
  antiga é motivo para revisão, não prova isolada de exploração.
- As imagens TronFire do repositório usam Node 22.23.4. Uma instalação com
  backend/worker antigos precisa reconstruir e recriar esses serviços para
  receber a correção anterior, independentemente do Node instalado no host.
- A nova rodada de segurança Node foi anunciada para 11/11/2026; em 06/11
  ainda não há versão corretiva publicada nesse boletim. Não inventar uma
  versão nem afirmar que 22.23.4 já cobre o aviso futuro.
- Esta mudança não atualiza automaticamente as cópias de Nginx embutidas nas
  imagens de KDS, QR e cardápio, nem o Nginx instalado no host.
- Debian 11 permanece por compatibilidade operacional; este patch não
  substitui a definição de suporte de segurança do sistema operacional.

## Validação em Debian 11

Em 06/11/2026, a VM 192.168.1.105 (Debian 11.11) recebeu o proxy 1.30.6 e
as imagens de gerenciamento reconstruídas com Node 22.23.4. Foram aprovados
os 83 testes existentes do backend host, a configuração `nginx -t` e a
comparação de 16 caminhos HTTP antes/depois. Os códigos e redirecionamentos
de QR, KDS, cardápio, Gerente, Retaguarda e APIs foram preservados.

Backend/worker ativos confirmados com Node 22.23.4, health do gerenciamento
HTTP 200 e `SELECT 1` pelo acesso da API ao Firebird. O processo Firebird
permaneceu com o mesmo PID. Nenhum container dos aplicativos Gerente ou
Retaguarda foi recriado. Suas correções de dependências foram adiadas pelo
usuário, pois dependem do outro desenvolvedor. Não foi feito login real
nem fluxo de pedidos nesta validação.

A validação aplica os componentes na VM; ela não equivale a aplicar o
atualizador completo do TronSoftOS nem a atualizar clientes em produção.
