# ISO TronSystem Debian 13

Perfil para remasterizar a ISO Debian 13 como instalador TronSystem preservando o menu original do Debian.

Inclui:

- menu original do Debian preservado, incluindo instalacao grafica;
- usuario `tronsoft`;
- SSH habilitado;
- pacotes `sudo`, `git`, `curl`, `ca-certificates` e `openssh-server`;
- comando `instalar` para o tecnico finalizar a instalacao no terminal;
- caminho padrao `/opt/tronos`;
- sudoers corrigido pelo `install.sh` para respeitar `TRONSOFTOS_APP_DIR`.

Uso no servidor que contem a ISO base:

```bash
cd /home/tronsoft/tronsoftos-route-worktree/iso
sudo bash build-tronsystem-iso.sh /home/tronsoft/debian-13*.iso /home/tronsoft/tronsystem-debian13.iso
```

Depois de instalar o Debian pela ISO, entrar no terminal:

```bash
instalar
```
